/**
 * Runtime ownership contract: the real Cockpit / Teammate / Flow extension
 * entries are loaded into one fake host and driven through a session, so the
 * handshake is *executed* instead of asserted against source text.
 *
 * Why this exists: the ghosting defect was a cross-extension ownership race
 * (both extensions mounted the same surface) plus widget churn (a re-created
 * widget factory on every update). Source-pattern tests stayed green through
 * both, so the contract is pinned here at the event/widget level.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Handler = (...args: any[]) => any;

/** Session identity the fake host binds; ownership projections must match it. */
const SESSION_ID = "ownership-test-session";

interface WidgetWrite {
	key: string;
	mounted: boolean;
	placement?: string;
	caller: string;
	factory?: any;
}

interface FooterWrite {
	active: boolean;
	caller: string;
}

interface Host {
	pi: any;
	ctx: any;
	fire(name: string): void;
	shortcuts: Map<string, any>;
	widgets: WidgetWrite[];
	footers: FooterWrite[];
	emitted: string[];
	cleanup(): void;
}

/** A cockpit config that makes Cockpit the single owner of every surface. */
function writeCockpitConfig(): string {
	const dir = mkdtempSync(join(tmpdir(), "cockpit-ownership-"));
	writeFileSync(join(dir, "cockpit.json"), JSON.stringify({
		version: 1,
		enabled: true,
		hideNativeAgents: true,
		sidebar: { mode: "off" },
	}, null, 2));
	return dir;
}

/** Stack frame of the extension code that issued a UI call (skips harness frames). */
function callerFrame(): string {
	for (const frame of (new Error().stack ?? "").split("\n").slice(1)) {
		if (frame.includes("ui-ownership-runtime.test.ts")) continue;
		const match = /packages[\\/](pi-[^\\/]+)[\\/](.+?):(\d+):\d+/.exec(frame);
		if (!match) continue;
		return `${match[1]}/${match[2]}:${match[3]}`.replaceAll("\\", "/");
	}
	return "unknown";
}

async function bootHost(order: readonly string[]): Promise<Host> {
	const agentDir = writeCockpitConfig();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const widgets: WidgetWrite[] = [];
	const footers: FooterWrite[] = [];
	const emitted: string[] = [];
	const bus = new Map<string, Set<Handler>>();
	const lifecycle = new Map<string, Set<Handler>>();
	const shortcuts = new Map<string, any>();

	const piBase: any = {
		registerFlag() {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerTool: () => () => {},
		registerCommand: () => () => {},
		registerShortcut: (key: string, config: any) => { shortcuts.set(key, config); },
		registerMessageRenderer: () => () => {},
		registerProvider() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		log() {}, warn() {}, error() {},
		events: {
			on(name: string, handler: Handler) {
				const set = bus.get(name) ?? new Set<Handler>();
				set.add(handler);
				bus.set(name, set);
				return () => set.delete(handler);
			},
			emit(name: string, payload: unknown) {
				emitted.push(name);
				for (const handler of [...(bus.get(name) ?? [])]) {
					try { handler(payload); } catch { /* extension listeners are best-effort */ }
				}
			},
			off(name: string, handler: Handler) { bus.get(name)?.delete(handler); },
		},
		on(name: string, handler: Handler) {
			const set = lifecycle.get(name) ?? new Set<Handler>();
			set.add(handler);
			lifecycle.set(name, set);
			return () => set.delete(handler);
		},
	};
	const pi: any = new Proxy(piBase, {
		get: (target: any, prop: string) => (prop in target ? target[prop] : () => undefined),
	});

	const theme: any = new Proxy({}, { get: () => (...args: any[]) => String(args[args.length - 1] ?? "") });
	const ui: any = new Proxy({
		setWidget(key: string, content: unknown, options?: any) {
			widgets.push({
				key,
				mounted: content !== undefined,
				placement: options?.placement,
				caller: callerFrame(),
				...(typeof content === "function" ? { factory: content } : {}),
			});
		},
		setFooter(factory?: unknown) {
			footers.push({ active: factory !== undefined, caller: callerFrame() });
		},
		setStatus() {}, setTitle() {}, setTheme() {}, getTheme: () => theme, getAllThemes: () => [],
		setHiddenThinkingLabel() {}, setEditorText() {}, getEditorText: () => "",
		getEditorComponent: () => undefined, setEditorComponent() {}, setWorkingIndicator() {}, setWorkingMessage() {},
		onTerminalInput: () => () => {}, addAutocompleteProvider: () => () => {}, notify() {},
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
	}, { get: (target: any, prop: string) => (prop in target ? target[prop] : () => undefined) });

	const ctx: any = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getConfig: () => ({}),
		getCwd: () => process.cwd(),
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionName: () => undefined,
			getSessionFile: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
			getMessages: () => [],
			getCwd: () => process.cwd(),
		},
	};

	const entries: Record<string, (pi: any) => void> = {
		cockpit: (await import("../src/index.ts")).default,
		teammate: (await import(new URL("../../pi-maestro-teammate/src/extension/index.ts", import.meta.url).href)).default,
		flow: (await import(new URL("../../pi-maestro-flow/src/extension/index.ts", import.meta.url).href)).default,
	};
	for (const name of order) {
		const entry = entries[name];
		assert.ok(entry, `unknown extension ${name}`);
		entry(pi);
	}

	const fire = (name: string): void => {
		for (const handler of [...(lifecycle.get(name) ?? [])]) {
			try { handler({ type: name }, ctx); } catch { /* handler-level failures are separate */ }
		}
	};

	return {
		pi, ctx, fire, shortcuts, widgets, footers, emitted,
		cleanup() {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		},
	};
}

const settle = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));

/** Render the currently mounted widget for `key` through its real factory. */
function renderSurface(host: Host, key: string, width = 100): string[] {
	const write = [...host.widgets].reverse().find((entry) => entry.key === key && entry.mounted && entry.factory);
	assert.ok(write, `${key} is mounted with a factory`);
	const theme: any = new Proxy({}, { get: () => (...args: any[]) => String(args[args.length - 1] ?? "") });
	const tui: any = {
		terminal: { columns: width, rows: 40 },
		requestRender() {},
		invalidate() {},
		setTitle() {},
	};
	return write.factory(tui, theme).render(width);
}

const countLines = (lines: readonly string[], needle: string): number =>
	lines.filter((line) => line.includes(needle)).length;

const orders: readonly (readonly string[])[] = [
	["cockpit", "teammate", "flow"],
	["teammate", "flow", "cockpit"],
	["flow", "teammate", "cockpit"],
];

for (const order of orders) {
	test(`single owner holds when extensions load as ${order.join(" → ")}`, async () => {
		const host = await bootHost(order);
		try {
			host.fire("session_start");
			await settle();

			// Cockpit claims its surfaces...
			const cockpitMounts = host.widgets.filter((write) => write.mounted && write.key.startsWith("cockpit-"));
			assert.ok(cockpitMounts.some((write) => write.key === "cockpit-agents"), "cockpit mounts its agent surface");
			assert.ok(cockpitMounts.some((write) => write.key === "cockpit-stack"), "cockpit mounts its stack surface");

			// ...while the native panels stay unmounted: no duplicate rows.
			const nativeMounts = host.widgets.filter((write) => write.mounted && (
				write.key === "teammate-agents" || write.key === "todo-panel" || write.key === "goal-panel"
			));
			assert.deepEqual(nativeMounts, [], "no native panel mounts while Cockpit owns the surface");

			// The handshake really crossed extensions: the alt+r shortcut delegates
			// instead of opening Teammate's own session picker.
			const delegationBefore = host.emitted.length;
			await host.shortcuts.get("alt+r")?.handler(host.ctx);
			assert.ok(
				host.emitted.slice(delegationBefore).includes("cockpit:open-session-list"),
				"Teammate delegates the session list to Cockpit",
			);

			// Teammate activity must not re-register a widget: churn is the other
			// half of the ghosting defect. The ownership replay added for the
			// handshake must not turn into a remount storm either.
			const writesBeforeBurst = host.widgets.length;
			const footersBeforeBurst = host.footers.length;
			for (let index = 0; index < 5; index += 1) {
				host.pi.events.emit("teammate:started", { correlationId: `agent-${index}`, agent: "general" });
			}
			await settle();
			assert.deepEqual(
				host.widgets.slice(writesBeforeBurst).filter((write) => write.key.startsWith("teammate")),
				[],
				"no teammate widget write during activity",
			);
			assert.deepEqual(
				host.widgets.slice(writesBeforeBurst).filter((write) => write.key.startsWith("cockpit-")),
				[],
				"the ownership replay does not re-register Cockpit surfaces",
			);
			assert.equal(
				host.footers.length,
				footersBeforeBurst,
				"the ownership replay does not remount the footer",
			);

			// Shutdown releases the surfaces: nothing is left mounted.
			host.fire("session_shutdown");
			await settle();
			for (const key of ["cockpit-agents", "cockpit-stack", "cockpit-session-bar"]) {
				const writes = host.widgets.filter((write) => write.key === key);
				assert.equal(writes.at(-1)?.mounted, false, `${key} is cleared on shutdown`);
			}
		} finally {
			host.cleanup();
		}
	});
}

test("a Teammate instance loaded after session_start still receives ownership", async () => {
	const host = await bootHost(["cockpit"]);
	try {
		host.fire("session_start");
		await settle();

		// Simulate /reload: the host re-runs the extension factory after the session
		// already started, so the one-shot session_start broadcast is in the past.
		const teammate = (await import(
			new URL("../../pi-maestro-teammate/src/extension/index.ts", import.meta.url).href
		)).default;
		teammate(host.pi, {});
		await settle(60);

		const before = host.emitted.length;
		await host.shortcuts.get("alt+r")?.handler(host.ctx);
		assert.ok(
			host.emitted.slice(before).includes("cockpit:open-session-list"),
			"a late-loaded Teammate converges without waiting for another session_start",
		);
	} finally {
		host.fire("session_shutdown");
		await settle();
		host.cleanup();
	}
});

test("one agent never renders twice on the Cockpit surface", async () => {
	const host = await bootHost(["cockpit", "teammate", "flow"]);
	try {
		host.fire("session_start");
		await settle();

		// A re-advertised agent (same correlationId) must upsert its row, not add a
		// second one: repeated rows are the visible form of the ghosting defect.
		// Real dispatches carry an ownership projection; Cockpit drops ownerless
		// starts once it has bound a session, so the payloads must carry one.
		const projection = { workspaceId: "ws-test", sessionId: SESSION_ID, sourceId: "src-test", generation: 1 };
		host.pi.events.emit("teammate:started", { correlationId: "dup-one", agent: "general", name: "dup-one", status: "running", projection });
		host.pi.events.emit("teammate:started", { correlationId: "dup-one", agent: "general", name: "dup-one", status: "running", projection });
		host.pi.events.emit("teammate:started", { correlationId: "dup-two", agent: "general", name: "dup-two", status: "running", projection });
		await settle();

		const lines = renderSurface(host, "cockpit-agents");
		assert.equal(countLines(lines, "dup-one"), 1, `dup-one renders once: ${JSON.stringify(lines)}`);
		assert.equal(countLines(lines, "dup-two"), 1, `dup-two renders once: ${JSON.stringify(lines)}`);
	} finally {
		host.fire("session_shutdown");
		await settle();
		host.cleanup();
	}
});

test("Cockpit is the only footer owner while Flow is loaded", async () => {
	const host = await bootHost(["flow", "cockpit", "teammate"]);
	try {
		host.fire("session_start");
		await settle();

		// Flow installs its statusline first and withdraws once Cockpit claims the
		// footer; a second live footer is exactly the duplicated-footer ghosting.
		assert.ok(host.footers.some((write) => write.caller.startsWith("pi-maestro-flow/src/statusline")), `Flow installs its statusline: ${JSON.stringify(host.footers)}`);
		const statuslineWrites = host.footers.filter((write) => write.caller.startsWith("pi-maestro-flow/src/statusline"));
		assert.equal(statuslineWrites.at(-1)?.active, false, "Flow withdraws its statusline");
		assert.equal(host.footers.at(-1)?.active, true, "Cockpit ends up owning the footer");
		assert.ok(host.footers.at(-1)?.caller.startsWith("pi-cockpit/"), "the surviving footer belongs to Cockpit");
	} finally {
		host.fire("session_shutdown");
		await settle();
		host.cleanup();
	}
});
