# Multi-Device Fabric Architecture

> Status: additive Fabric v1 contract architecture. Phase 3-6 public shapes are frozen in `pi-maestro-fabric-core`; runtime implementations remain phase-specific.

## 1. Architectural layers

```text
Clients / Agent Runtimes
        |
        v
Access Plane
  OAuth, public MCP, connector WSS, tunnel, relay
        |
        +-----------------------+
        v                       v
Control Plane               Task Plane
  Device Registry             Board / Task authority
  Connector Registry          ownership / dependency
  Connection Manager          Agent inbox / events
  Workspace Directory
  Endpoint Registry
  Capability Index
  Presence / Route Directory
        |
        v
Invocation Plane
  MCP mount / list / describe / call
  cancellation / receipts / streaming / artifacts
        |
        v
Connectors -> Devices -> Workspaces -> Endpoints
```

The VPS control plane contains no LLM and no planner. It validates identities, selects only policy-approved route candidates, and maintains deterministic state. Agents decide whether to delegate or invoke.

## 2. Object hierarchy

```text
Connector 1 --- N Device
Device    1 --- N Workspace
Device or Workspace 1 --- N Endpoint
Endpoint  1 --- N CapabilityBinding
Agent Runtime Endpoint 1 --- N transient AgentInstance
```

### 2.1 Device

A device is a managed machine or logical host even when it does not run a Connector or Agent. An Edge Connector may represent multiple MCP-only devices.

```ts
interface DeviceRecord {
  deviceId: string;
  label: string;
  connectorId: string;
  connectionMode: "direct" | "edge-managed" | "ssh" | "https";
  platform?: string;
  architecture?: string;
  enabled: boolean;
  revision: number;
}
```

### 2.2 Connector

A Connector owns network identity and advertises devices/routes. It is infrastructure, not an Agent.

```ts
interface ConnectorRecord {
  connectorId: string;
  label: string;
  transport: "outbound-wss" | "ssh" | "direct-https" | "edge-relay";
  credentialGeneration: number;
  instanceNonce?: string;
  lastSeenAt?: number;
  revision: number;
}
```

Connector presence does not imply that every managed device or endpoint is healthy.

### 2.3 Connection

A connection is an explicit, temporary authority. Registry presence alone never authorizes execution.

```ts
interface ConnectionLease {
  connectionId: string;
  deviceId: string;
  connectorId: string;
  connectorInstanceNonce: string;
  generation: number;
  state: "connecting" | "connected" | "draining" | "closed";
  capabilityDigest: string;
  establishedAt: number;
  expiresAt: number;
}
```

### 2.4 Workspace

A workspace is the data and policy boundary on one device. The hub stores IDs and metadata, not device absolute paths.

```ts
interface WorkspaceRecord {
  workspaceId: string;       // Hub-opaque ID, unique across all devices
  deviceId: string;
  localWorkspaceId: string;  // device-local Gateway identity; never globally authoritative
  label: string;
  mode: "lease" | "permanent";
  generation: number;
  endpointIds: string[];
}

interface WorkspaceBinding {
  bindingId: string;
  connectionId: string;
  deviceId: string;
  workspaceId: string;
  workspaceGeneration: number;
  policyDigest: string;
  expiresAt: number;
}
```

Device-local Connectors resolve `localWorkspaceId` to a canonical path and reauthorize every operation. The Hub identity is either an opaque generated ID or a device-qualified digest; it is never the current path-derived local ID by itself. Two devices exposing the same canonical path remain distinct. The Hub stores only the mapping `(deviceId, workspaceId, localWorkspaceId, generation)` and a redacted projection; remote requests use workspace-relative paths.

### 2.5 Endpoint

An endpoint is either an Agent Runtime or an MCP service. A process that provides both publishes two endpoints with a common device/workspace relationship.

```ts
type EndpointRecord = AgentRuntimeEndpoint | McpServiceEndpoint;

interface EndpointBase {
  endpointId: string;
  deviceId: string;
  connectorId: string;
  scope: { kind: "device" } | { kind: "workspace"; workspaceId: string };
  generation: number;
  contractHash: string;
  status: "unknown" | "online" | "offline" | "disabled";
}

interface AgentRuntimeEndpoint extends EndpointBase {
  kind: "agent";
  roles: string[];
  taskTypes: string[];
  models: string[];
  maxConcurrency: number;
}

interface McpServiceEndpoint extends EndpointBase {
  kind: "mcp";
  serverName: string;
  protocolVersion: string;
  transport: "stdio" | "http" | "streamable-http" | "edge-relay";
}
```

### 2.6 Capability

Capability is a derived discovery index, not an execution address.

```ts
type CapabilityKind = "agent-competency" | "tool" | "resource" | "control";

interface CapabilityBinding {
  capabilityId: string;
  kind: CapabilityKind;
  endpointId: string;
  inputSchema?: object;
  contractHash: string;
  trustLevel: string;
  locality?: string;
  priority: number;
}
```

`resolveCapability` returns ordered candidates and reasons. It cannot connect or execute. Mutating operations require an explicitly selected device/endpoint.

## 3. Connection-first state machine

```text
Device selected
  -> connector and route candidates validated
  -> connection admitted
  -> handshake validates instance nonce, protocol and capability digest
  -> optional workspace binding admitted
  -> endpoint selected and generation validated
  -> explicit route.open admission
  -> route handle issued
  -> teammate or MCP execution
```

```ts
interface EndpointRouteHandle {
  routeId: string;
  connectionId: string;
  workspaceBindingId?: string;
  endpointId: string;
  connectionGeneration: number;
  endpointGeneration: number;
  expiresAt: number;
}
```

Execution rejects absent, expired, stale, foreign, or wrong-scope handles. A route may use a pre-negotiated path fallback (`lan-direct -> edge-relay -> vps-relay`) only for the same endpoint. It never switches devices or endpoints silently.

## 4. Three protocol families

### 4.1 Connector control protocol

Model-hidden operations:

```text
pair / register / connect / hello / ready / heartbeat
advertise-device / advertise-workspace / advertise-endpoint
route-negotiate / drain / disconnect
```

Pairing credentials are connector-scoped, hashed at rest, rotatable, revocable, audience-bound, and generation-fenced.

### 4.2 Agent delegation protocol

Only Agent Runtime endpoints accept delegation. Dispatch creates a transient Agent instance.

```text
Task/Board authority
  -> placement on Agent Runtime Endpoint
  -> teammate AgentSession
  -> correlationId / owner / session / completion publication
```

The current teammate graph remains authoritative for `tasks`, `dependsOn`, output injection, roles, task types, models, context, output schema, nesting, background completion, and messages. Remote placement adds a route constraint; it does not create a second dispatch engine. The first implementation uses a Fabric-backed `TeammateBackend` adapter so the existing host remains the sole authority for model selection, fallback, attempt recovery, reclamation, completion publication, and `onTurnComplete`. A route fixes the execution endpoint: model/backend selection may vary only within capabilities advertised by that endpoint, and conflicts are rejected. On disconnect, a replacement attempt is forbidden until the backend supplies real recovery facts and confirms reclamation; outcome-unknown work is not replayed.

```ts
interface TeammatePlacement {
  routeId: string;
  workspaceBindingId: string;
  agentEndpointId: string;
}
```

Current `todo` IDs remain local to their authority. Cross-device work binds a central Board/Task ID or passes a bounded snapshot; it never maps a local Todo ID into a remote Todo authority.

### 4.3 MCP invocation protocol

MCP endpoints use the existing MCP adapter lifecycle rather than a new generic `endpoint.invoke` tool.

After connection and workspace binding, Fabric mounts a temporary provider-managed MCP server projection:

```text
route:<binding-id>:<endpoint-id>
```

The existing `mcp` proxy continues to own:

```text
status -> server/list -> search -> describe -> connect -> tool call
OAuth/consent -> connection lease -> content conversion -> output guard
```

Remote projections are unavailable before connection, are not written as ordinary permanent MCP configuration, and expire with their route generation. Fabric connection/workspace/route authorization is an outer fence; the MCP adapter's server connection lease is a separate inner fence. Every call, late initialization, OAuth return, reconnect, metadata refresh, and direct-tool dispatch revalidates the outer fence. The MCP adapter may reconnect its inner session but may never recreate an expired Fabric connection. Mount identity, metadata cache, direct tools, and cleanup share one route generation; first-match routing across mounts is forbidden.

MCP calls may be mutating, asynchronous, or outcome-unknown. An `operationId` or Hub-side log does not make a call replayable. Arbitrary MCP mutations default to non-replayable/outcome-unknown; `receipt-backed` is allowed only when the target endpoint advertises and proves a durable deduplication contract whose side effect and receipt commit share one authority.

## 5. Current tool mapping

| Existing surface | Fabric role |
|---|---|
| `teammate` | Delegate to an Agent Runtime endpoint and create Agent instances |
| `teammate-send` | Message an already created Agent instance |
| `todo` | Local Pi/workspace task authority |
| `board` | Shared cross-session/cross-device task coordination authority |
| `monitor` / `observe` | Connection, endpoint, execution, and Agent instance observation |
| `mcp` | MCP endpoint discovery and invocation after mounting |
| `ssh` | Compatibility projection over an SSH DeviceTransport |
| Gateway `session` | Device/workspace/member execution binding |
| `resource` | Agent results, session entries, and future artifact references |
| Tunnel profiles | Hub public ingress or explicit direct-device fallback |

Suggested new control surfaces are deliberately small:

```text
device: list/get/pair/connect/disconnect/status/workspaces
workspace: list/bind/renew/unbind
endpoint: list/describe/select
route: open/renew/close
```

Execution remains in `teammate` and `mcp`.

## 6. Example flows

### 6.1 Delegate to a remote Agent

```text
device.connect(windows-b)
workspace.bind(project-b)
endpoint.list(kind=agent)
endpoint.select(agent/windows-b/pi)
route.open(selected endpoint)
teammate(tasks=[... placement=route ...])
monitor(correlationId)
resource(agent://publication)
```

### 6.2 Invoke an MCP-only server through an Edge

```text
device.connect(server-s)
  -> connector=edge-office
workspace.bind(server-s/project-a)
endpoint.list(kind=mcp)
endpoint.select(mcp/server-s/files)
route.open(selected endpoint)
mount mcp/server-s/files as route:...:files
mcp describe filesystem.read
mcp call filesystem.read
```

The MCP service appears as invocation events and receipts, never as Task owner.

### 6.3 LAN direct route

The hub first establishes the logical connection and issues a short-lived, subject/endpoint/tool/audience-bound route ticket. The agent then opens the LAN data path. LAN failure may fall back to a pre-negotiated relay path for the same endpoint; it cannot trigger endpoint reselection.

## 7. State authority

| State | Authority |
|---|---|
| Device/Connector/Endpoint registry | Hub Fabric registry |
| Current connection/presence | Connection Manager + durable last-known event |
| Workspace canonical path | Device/Edge Connector |
| Workspace registration metadata | Device-local WorkspaceRegistry authority; Hub stores only device-qualified projection/mapping |
| Board | Exactly one selected workspace/Hub Board authority; indexes and attachments are not second writers |
| Gateway Todo | Gateway workspace/session authority, distinct from Board and Pi Todo |
| Pi Todo | Origin Pi/workspace authority only |
| Cross-device task reference | Qualified `(authority, workspaceId, taskId)` reference plus optional read-only snapshot |
| Agent instance/runtime state | Target teammate runtime |
| MCP session/connection | MCP adapter/Fabric mount |
| Files/processes/browser profiles | Device local runtime |
| Knowledge | Existing governed knowledge authority |
| Artifact metadata | Hub index; bytes source-local or optionally cached |

## 8. Security and correctness invariants

1. No implicit connection or execution during capability search.
2. Device, workspace, endpoint, and capability IDs are separate.
3. Workspace-scoped execution requires a current Workspace Binding.
4. Connection, endpoint, and workspace generations fence every route.
5. Agent Endpoint and transient Agent instance are separate objects.
6. MCP endpoints cannot claim or own Tasks.
7. Hub authorization is repeated at the Connector/local runtime boundary.
8. LAN is not a trusted boundary; direct routes use short-lived route tickets.
9. Raw connector, device, or MCP credentials are never returned to agents.
10. Reconnect invalidates prior mounts and handles.
11. Automatic replay is limited to readonly operations or endpoint-proven durable deduplication; Hub receipts alone are insufficient.
12. Endpoint fallback cannot silently change the selected device or service.
13. Registry presence is not online status; Connector, Device, and Endpoint health are distinct.
14. Flow-to-teammate integration uses versioned public contracts or runtime provider registration, never reverse static imports.
15. Legacy SSH/MCP entry points may keep legacy lazy connection only in their old schema; any Fabric device/workspace/route field opts into strict connection-first validation, and unsupported consumers fail closed.
16. Pi Todo, Gateway Todo, and Board remain three distinct authorities; links carry qualified identity and never imply shared ownership.

## 9. Locked v1 decisions

- WSS termination is a host adapter concern. Core exposes versioned envelopes and channels and does not select Gateway-daemon versus dedicated-service deployment.
- The five logical store authorities are `registry`, `lease`, `presence`, `invocation`, and `event`; implementations are replaceable. Persisted shapes write `shapeVersion: 1` and legacy shapes migrate only at the read boundary.
- MCP mounts are scoped to exactly one Pi session and one route. Cross-session sharing requires a later contract version.
- Artifact bytes remain source-local by default. `hub-cache` is an explicit descriptor value, never an implicit fallback.
- Edge discovery is explicit allow-list configuration in v1. Automatic LAN discovery is outside v1.
- LAN direct paths require TLS plus a short-lived signed route ticket. The signature proof is opaque to Core and supplied by a registered security adapter; no raw key material enters public contracts.
- Cross-authority tasks use `(authority, workspaceId, taskId)` and optional bounded read-only snapshots. Equal-looking IDs never merge Pi Todo, Gateway Todo, or Board ownership.

The protocol-specific details are fixed by `security.md`, `edge.md`, `mcp-federation.md`, and `teammate-placement.md`; runtime implementation may vary only behind these boundaries.