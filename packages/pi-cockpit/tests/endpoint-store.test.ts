import assert from "node:assert/strict";
import test from "node:test";
import type { ExternalAgentProjectionV1 } from "pi-maestro-teammate/v1/external-agent-projections";
import {
	SessionHostRegistry,
	projectSessionEndpoints,
	type SessionOwnerProjection,
} from "pi-maestro-teammate/v1/sessions";
import {
	EndpointStore,
	FABRIC_MONITOR_SNAPSHOT_EVENT,
	LEGACY_MAIN_ENDPOINT_ID,
	SESSION_HOST_REGISTRY_EVENT,
	type SessionEventSource,
} from "../src/endpoint-store.ts";
import type { AgentRow, FabricMonitorSnapshot } from "../src/types.ts";

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		correlationId: "c1",
		agent: "general",
		name: "builder",
		role: "general",
		task: "build",
		status: "running",
		tail: "",
		startedAt: 1_000,
		lastActivityAt: 1_000,
		...overrides,
	};
}

const WORKSPACE = "w".repeat(64);
const OWNER = "a".repeat(32);
const NONCE = "1".repeat(32);
const SESSION = "main-session";
const SOURCE = "main-source";
const GENERATION = 7;

function owners(name = "builder"): SessionOwnerProjection[] {
	return [{
		workspaceId: WORKSPACE,
		ownerId: OWNER,
		ownerNonce: NONCE,
		scope: "local",
		status: "running",
		sessionId: SESSION,
		sourceId: SOURCE,
		generation: GENERATION,
		sessionName: "main-window",
		agents: [{
			workspaceId: WORKSPACE,
			ownerId: OWNER,
			ownerNonce: NONCE,
			correlationId: "c1",
			status: "running",
			name,
			agent: "general",
		}],
	}, {
		workspaceId: WORKSPACE,
		ownerId: "b".repeat(32),
		ownerNonce: "2".repeat(32),
		scope: "workspace-peer",
		status: "running",
		sessionName: "other-window",
		agents: [],
	}];
}

function snapshotWithLocalProjection(
	overrides: Partial<Pick<SessionOwnerProjection, "workspaceId" | "sessionId" | "sourceId" | "generation">> = {},
) {
	const projectedOwners = owners();
	projectedOwners[0] = { ...projectedOwners[0]!, ...overrides };
	return new SessionHostRegistry({ endpoints: projectSessionEndpoints(projectedOwners) }).snapshot();
}

class Events implements SessionEventSource {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

function fabricSnapshot(overrides: Partial<FabricMonitorSnapshot> = {}): FabricMonitorSnapshot {
	return {
		version: 1,
		sourceId: "fabric-source-a",
		revision: 1,
		capturedAt: 10,
		truncated: false,
		itemCount: 3,
		cursors: [{ handle: "fabric:registry", storeKind: "registry", cursor: 4 }],
		connectors: [{
			kind: "connector",
			connectorId: "connector-1",
			label: "Connector\u001b[31m red\n",
			transport: "stdio\tlocal",
			health: "online",
			enabled: true,
			revision: 2,
			connectionId: "connection-1",
			connectionGeneration: 1,
		}],
		devices: [{
			kind: "device",
			deviceId: "device-1",
			connectorId: "connector-1",
			label: "Device\n one",
			health: "degraded",
			enabled: true,
			revision: 3,
		}],
		endpoints: [{
			kind: "endpoint",
			endpointId: "mcp-1",
			deviceId: "device-1",
			connectorId: "connector-1",
			endpointKind: "mcp",
			label: "MCP\t server",
			health: "offline",
			status: "offline",
			generation: 1,
			revision: 4,
		}],
		...overrides,
	};
}

test("EndpointStore falls back to stable main/start-order agent ids and hides graph containers", () => {
	let rows = [
		agent({ correlationId: "later", name: "later", startedAt: 20 }),
		agent({ correlationId: "graph", agent: "graph(2)", startedAt: 1 }),
		agent({ correlationId: "first", name: "first", startedAt: 10 }),
	];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const first = store.snapshot();
	assert.equal(first.mainEndpointId, LEGACY_MAIN_ENDPOINT_ID);
	assert.deepEqual(first.endpoints.map((endpoint) => endpoint.label), ["main", "first", "later"]);
	assert.ok(first.endpoints.every((endpoint) => endpoint.id.startsWith("cockpit-session/v1/")));

	rows = rows.map((row) => ({ ...row, lastActivityAt: row.lastActivityAt + 100 }));
	store.refreshLegacy();
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "first", "later"]);
});

test("EndpointStore adds read-only external agents without creating registry endpoints or route selectors", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	const projection: ExternalAgentProjectionV1 = {
		version: 1,
		source: "ssh-gateway",
		sessionId: SESSION,
		id: "remote-1",
		label: "remote-builder",
		status: "running",
		activeTool: "bash",
		metrics: { toolCount: 3, tokens: 1_200 },
		revision: "r1",
		updatedAt: 10,
	};
	store.setExternalAgents([projection]);

	const external = store.snapshot().endpoints[1];
	assert.equal(external?.source, "external");
	assert.equal(external?.readOnly, true);
	assert.equal(external?.kind, "agent");
	assert.equal(external?.correlationId, undefined);
	assert.equal(external?.routeSelector, "");
	assert.equal(external?.registryEndpoint, undefined);
	assert.equal(external?.externalAgent, projection);
	assert.equal(store.findAgent("remote-1"), undefined, "external ids never enter local teammate lookup");

	store.disconnect();
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main"]);
});

test("EndpointStore subscribes to SessionHostRegistry and projects canonical local endpoints only", () => {
	let rows = [agent({
		workspaceId: WORKSPACE,
		sessionId: SESSION,
		sourceId: SOURCE,
		sessionGeneration: GENERATION,
	})];
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const revisions: string[] = [];
	store.subscribe((snapshot) => revisions.push(snapshot.contentRevision));
	store.connect({ registry });

	const snapshot = store.snapshot();
	assert.equal(snapshot.endpoints.length, 2, "workspace-peer roots belong to the future Window Bar");
	assert.deepEqual(snapshot.endpoints.map((endpoint) => endpoint.kind), ["root", "agent"]);
	assert.ok(snapshot.endpoints.every((endpoint) => endpoint.source === "registry"));
	assert.equal(snapshot.endpoints[1]?.agentRow, rows[0]);
	assert.equal(snapshot.endpoints[1]?.routeSelector, "c1");

	registry.replaceEndpoints(projectSessionEndpoints(owners("reviewer")));
	assert.equal(store.snapshot().endpoints[1]?.label, "builder", "live legacy content keeps the current local label");
	rows = [];
	store.refreshLegacy();
	assert.equal(store.snapshot().endpoints[1]?.label, "reviewer");
	assert.ok(revisions.length >= 3);
	store.disconnect();
});

test("EndpointStore excludes local agents outside the current root owner fence", () => {
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	const canonical = registry.snapshot();
	const localAgent = canonical.endpoints.find((endpoint) => endpoint.kind === "agent" && endpoint.scope === "local");
	assert.ok(localAgent);
	const foreignOwner = "0".repeat(32);
	const foreignNonce = "3".repeat(32);
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	assert.equal(store.applyRegistrySnapshot({
		...canonical,
		contentRevision: "foreign-local-agent",
		endpointContentRevision: "foreign-local-agent-endpoints",
		endpoints: [...canonical.endpoints, {
			...localAgent,
			id: `${localAgent.id}-foreign`,
			ownerId: foreignOwner,
			ownerNonce: foreignNonce,
			correlationId: "foreign-agent",
			name: "foreign",
			contentRevision: "foreign-agent",
		}],
	}), true);
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder"]);
	assert.equal(store.snapshot().endpoints.some((endpoint) => endpoint.correlationId === "foreign-agent"), false);
});

test("EndpointStore rejects a late canonical snapshot from the previous Cockpit session", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.connect({ sessionId: SESSION });
	const stale = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) }).snapshot();
	assert.equal(store.applyRegistrySnapshot({
		...stale,
		contentRevision: "stale-session",
		endpoints: stale.endpoints.map((endpoint) => endpoint.scope === "local"
			? { ...endpoint, sessionId: "previous-session" }
			: endpoint),
	}), false);
	assert.equal(store.snapshot().endpoints.length, 1);
	store.disconnect();
});

test("EndpointStore rejects lower-generation and incompatible same-session local snapshots", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.connect({ sessionId: SESSION });
	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection()), true);

	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection({
		generation: GENERATION - 1,
	})), false, "a late lower generation cannot regress the accepted projection");
	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection({
		sourceId: "other-source",
		generation: GENERATION + 1,
	})), false, "a higher generation cannot silently switch canonical sources");
	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection({
		workspaceId: "x".repeat(64),
		generation: GENERATION + 1,
	})), false, "a higher generation cannot silently switch workspaces");
	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection({
		sourceId: undefined,
	})), false, "session-bound snapshots require the complete local tuple");
	assert.equal(store.snapshot().endpoints[0]?.registryEndpoint?.generation, GENERATION);

	store.disconnect();
	store.connect({ sessionId: SESSION });
	assert.equal(store.applyRegistrySnapshot(snapshotWithLocalProjection({
		workspaceId: "x".repeat(64),
		sourceId: "replacement-source",
		generation: 1,
	})), true, "an explicit reconnect resets the accepted workspace/source/generation tuple");
	store.disconnect();
});

test("EndpointStore accepts versioned session events and hides unknown legacy agents once a canonical registry exists", () => {
	const rows = [agent({ correlationId: "legacy-extra", name: "extra", startedAt: 2_000 })];
	const events = new Events();
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	store.connect({ events });
	const registry = new SessionHostRegistry({ endpoints: projectSessionEndpoints(owners()) });
	events.emit(SESSION_HOST_REGISTRY_EVENT, registry.snapshot());

	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder"]);
	assert.equal(events.handlers.get(SESSION_HOST_REGISTRY_EVENT)?.size, 1);
	store.disconnect();
	assert.equal(events.handlers.get(SESSION_HOST_REGISTRY_EVENT)?.size, 0);
});

test("EndpointStore stores a sanitized immutable Fabric snapshot without creating selectable endpoints", () => {
	const events = new Events();
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.connect({ events });
	const beforeRevision = store.snapshot().contentRevision;
	const payload = {
		...fabricSnapshot(),
		secretPath: "C:/private/token.txt",
		connectors: fabricSnapshot().connectors.map((connector) => ({
			...connector,
			credential: "do-not-store",
		})),
	};
	events.emit(FABRIC_MONITOR_SNAPSHOT_EVENT, payload);

	const snapshot = store.snapshot();
	assert.notEqual(snapshot.contentRevision, beforeRevision);
	assert.equal(snapshot.fabric?.connectors[0]?.label, "Connector red");
	assert.equal(snapshot.fabric?.connectors[0]?.transport, "stdio local");
	assert.equal(snapshot.fabric?.devices[0]?.label, "Device one");
	assert.equal(snapshot.fabric?.endpoints[0]?.label, "MCP server");
	assert.equal("secretPath" in (snapshot.fabric as unknown as object), false);
	assert.equal("credential" in (snapshot.fabric?.connectors[0] as unknown as object), false);
	assert.equal(Object.isFrozen(snapshot.fabric), true);
	assert.equal(Object.isFrozen(snapshot.fabric?.connectors), true);
	assert.equal(Object.isFrozen(snapshot.fabric?.connectors[0]), true);
	assert.deepEqual(snapshot.endpoints.map((endpoint) => endpoint.label), ["main"]);
	assert.equal(store.get("mcp-1"), undefined);
	assert.equal(store.findAgent("mcp-1"), undefined);
	assert.equal(events.handlers.get(FABRIC_MONITOR_SNAPSHOT_EVENT)?.size, 1);

	store.disconnect();
	assert.equal(store.snapshot().fabric, undefined);
	assert.equal(events.handlers.get(FABRIC_MONITOR_SNAPSHOT_EVENT)?.size, 0);
});

test("EndpointStore fences Fabric revisions and retired sources", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({ revision: 2, capturedAt: 100 })), true);
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({ revision: 2, capturedAt: 101 })), false);
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({ revision: 1, capturedAt: 102 })), false);
	assert.equal(store.snapshot().fabric?.revision, 2);

	assert.equal(store.applyFabricSnapshot(fabricSnapshot({
		sourceId: "fabric-source-b",
		revision: 1,
		capturedAt: 100,
	})), false, "a source switch must have a newer capture time");
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({
		sourceId: "fabric-source-b",
		revision: 1,
		capturedAt: 101,
	})), true);
	assert.equal(store.snapshot().fabric?.sourceId, "fabric-source-b");
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({
		sourceId: "fabric-source-a",
		revision: 3,
		capturedAt: 102,
	})), false, "a retired source cannot re-enter even with newer data");
});

test("EndpointStore rejects oversized, over-limit, and invalid Fabric payloads", () => {
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({
		connectors: [{ ...fabricSnapshot().connectors[0]!, label: "x".repeat(65 * 1024) }],
	})), false);

	const endpoint = fabricSnapshot().endpoints[0]!;
	const tooMany = Array.from({ length: 101 }, (_, index) => ({
		...endpoint,
		endpointId: `mcp-${index}`,
	}));
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({
		itemCount: tooMany.length,
		connectors: [],
		devices: [],
		endpoints: tooMany,
	})), false);
	assert.equal(store.applyFabricSnapshot({
		...fabricSnapshot(),
		sourceId: "unsafe/source",
	}), false);
	assert.equal(store.applyFabricSnapshot({
		...fabricSnapshot(),
		endpoints: [{ ...endpoint, health: "healthy" }],
	}), false);
	assert.equal(store.applyFabricSnapshot({
		...fabricSnapshot(),
		cursors: [fabricSnapshot().cursors[0], fabricSnapshot().cursors[0]],
	}), false);
	assert.equal(store.applyFabricSnapshot({
		...fabricSnapshot(),
		revision: Number.MAX_SAFE_INTEGER + 1,
	}), false);
	assert.equal(store.snapshot().fabric, undefined);
});

test("EndpointStore revokes Fabric state on an undefined event", () => {
	const events = new Events();
	const store = new EndpointStore({ getLegacyAgents: () => [] });
	store.connect({ events });
	events.emit(FABRIC_MONITOR_SNAPSHOT_EVENT, fabricSnapshot());
	assert.ok(store.snapshot().fabric);
	events.emit(FABRIC_MONITOR_SNAPSHOT_EVENT, undefined);
	assert.equal(store.snapshot().fabric, undefined);
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({ revision: 1, capturedAt: 11 })), false,
		"a cleared source cannot replay its prior revision");
	assert.equal(store.applyFabricSnapshot(fabricSnapshot({ revision: 2, capturedAt: 11 })), true,
		"the same Gateway runtime may publish a newer snapshot after the overlay reopens");
});

test("EndpointStore output revision ignores status-only churn and changes with new output", () => {
	let rows = [agent({ tail: "first output" })];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	const before = store.snapshot().endpoints[1]?.outputRevision;
	rows = [{ ...rows[0]!, status: "retrying", lastActivityAt: 2_000 }];
	store.refreshLegacy();
	assert.equal(store.snapshot().endpoints[1]?.outputRevision, before);
	rows = [{ ...rows[0]!, tail: "second output", lastActivityAt: 3_000 }];
	store.refreshLegacy();
	assert.notEqual(store.snapshot().endpoints[1]?.outputRevision, before);
});

test("EndpointStore numbers visible duplicate agent labels", () => {
	const rows = [
		agent({ correlationId: "builder-a", name: "builder", startedAt: 10 }),
		agent({ correlationId: "builder-b", name: "builder", startedAt: 20 }),
	];
	const store = new EndpointStore({ getLegacyAgents: () => rows });
	assert.deepEqual(store.snapshot().endpoints.map((endpoint) => endpoint.label), ["main", "builder·1", "builder·2"]);
});
