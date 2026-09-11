# Multi-Device Fabric Package Boundaries

> Status: Phase 2 connection kernel implemented and Phase 3-6 additive public contracts frozen. Runtime Flow, MCP, teammate, WSS, Edge, and artifact integrations remain later implementation tasks.

## 1. Why isolate the feature

Multi-device support crosses Gateway, SSH, teammate, MCP, Board, Monitor, tunnels, and settings. Implementing it directly inside `pi-maestro-flow/src/gateway` would make Gateway own transport contracts, device identity, endpoint discovery, teammate placement, and MCP mounting at once. That would create cycles and make the protocol impossible to reuse outside the Flow extension.

The feature should therefore be isolated behind versioned contracts and adapter registration.

## 2. Proposed packages

### 2.1 `pi-maestro-fabric-core`

A small, publishable, runtime-light contract package.

Owns:

- versioned IDs and records for Device, Connector, Connection, Workspace Binding, Endpoint, Capability, Route, Invocation, Presence, and Artifact descriptors;
- state enums and transition validation;
- protocol envelopes and error codes;
- limits, byte bounds, identifier validation, and redacted public projections;
- transport/provider interfaces;
- serialization compatibility tests.

Does not own:

- filesystem/network processes;
- Gateway stores or IPC;
- Pi extension registration or TUI;
- teammate execution;
- MCP client sessions;
- SSH implementation;
- secrets.

Suggested exports:

```text
pi-maestro-fabric-core/v1
pi-maestro-fabric-core/v1/device
pi-maestro-fabric-core/v1/connection
pi-maestro-fabric-core/v1/workspace
pi-maestro-fabric-core/v1/endpoint
pi-maestro-fabric-core/v1/capability
pi-maestro-fabric-core/v1/control
pi-maestro-fabric-core/v1/store
pi-maestro-fabric-core/v1/mount
pi-maestro-fabric-core/v1/placement
pi-maestro-fabric-core/v1/artifact
pi-maestro-fabric-core/v1/security
pi-maestro-fabric-core/v1/route
pi-maestro-fabric-core/v1/invocation
pi-maestro-fabric-core/v1/protocol
pi-maestro-fabric-core/v1/transport
pi-maestro-fabric-core/v1/validation
pi-maestro-fabric-core/v1/projection
```

This follows the existing `pi-maestro-backend-core` and `pi-maestro-settings-core` pattern: versioned public types are stable while implementations evolve independently.

### 2.2 `pi-maestro-fabric`

The host-independent runtime implementation.

Owns:

- Device/Connector/Endpoint registries;
- Connection Manager and lease/generation lifecycle;
- Workspace Binding manager;
- deterministic capability index;
- route negotiation and route-handle validation;
- presence aggregation and event cursors;
- transport registry;
- provider-managed MCP mount descriptors;
- operation receipt interfaces and artifact transfer orchestration.

Initial transport adapters:

```text
ssh
paired-gateway-https
outbound-wss (later phase)
edge-relay (later phase)
```

Does not own:

- Pi tool schemas or overlays;
- teammate graph execution;
- MCP content conversion/UI/OAuth implementation;
- Board/Todo stores;
- Gateway HTTP listener or tunnel process implementation.

It depends on `pi-maestro-fabric-core`, not on Flow or teammate.

## 3. Integration ownership

### `pi-maestro-flow`

Keeps application integration:

- Gateway MCP control handlers;
- `/gateway` and future Fabric TUI;
- `device`, `workspace`, and `endpoint` Pi/Gateway tool surfaces;
- adaptation of existing Gateway PairingStore, WorkspaceRegistry, SessionStore, EventJournal, and operation receipts;
- adaptation of the existing SSH manager into a Fabric transport;
- remote MCP mount registration into the current MCP adapter;
- Board/Session policy and audit integration;
- tunnel profiles for Hub ingress and direct-device fallback.

Flow depends on Fabric packages. Fabric never imports Flow.

### `pi-maestro-teammate`

Keeps:

- DAG validation and dispatch;
- AgentSession creation;
- roles/models/task types;
- background and completion durability;
- correlation IDs, messaging, observation, and result publication;
- backend capability adjudication and replay safety.

The first implementation uses a Fabric-backed `TeammateBackend` adapter through `pi-maestro-backend-core`. This preserves the existing host authority for model routing, fallback, live channels, `onTurnComplete`, recovery facts, reclamation, and completion durability. A separate placement-provider seam is deferred until a concrete requirement cannot be expressed by the backend contract.

Teammate must not import Flow. If teammate imports Fabric types, it may import only `pi-maestro-fabric-core/v1/*`. Fabric Core owns route/placement identifiers but does not own `TeammateRunSpec`; the adapter maps teammate public contracts to Fabric contracts. Flow-owned projections cross the boundary through runtime registration rather than reverse static dependencies.

### MCP adapter in Flow

Keeps the existing model-facing `mcp` proxy and owns:

- server status/search/describe/connect/tool dispatch precedence;
- OAuth, consent, sampling, and elicitation;
- connection leases and generation fences;
- metadata cache and selective direct tools;
- MCP content conversion, UI resources, and output guards.

Fabric supplies temporary mount descriptors and route leases. It does not duplicate MCP protocol execution. Fabric connection/workspace authorization and MCP connection leases remain separate fences: every call and asynchronous continuation must revalidate the outer Fabric route; inner MCP auto-connect may never recreate an expired outer connection. Metadata, direct tools, OAuth returns, and cleanup are generation-owned by the same mount.

## 4. Dependency graph

```text
Legend: `-->` static dependency, `~~>` runtime registration.

pi-maestro-fabric-core
      ^                 ^
      |                 |
pi-maestro-fabric   pi-maestro-teammate (optional contract-only dependency)
      ^                 ^
      |                 |
pi-maestro-flow --------+  existing public teammate imports only
      |
      +~~> Fabric-backed TeammateBackend registration
      +~~> existing MCP adapter mount registration
      +--> Gateway / SSH / Board / Session / TUI integrations
```

Forbidden dependencies:

```text
fabric-core -> fabric/flow/teammate
fabric      -> flow/teammate/MCP UI
teammate    -> flow
Gateway store code -> teammate internals
MCP adapter -> Fabric persistence implementation
```

## 5. Public interface sketches

### Transport provider

```ts
interface FabricTransportProvider {
  readonly kind: string;
  connect(request: ConnectRequest, signal: AbortSignal): Promise<LiveConnection>;
  describe(connection: LiveConnection, signal: AbortSignal): Promise<ConnectionDescriptor>;
  close(connection: LiveConnection): Promise<void>;
}
```

`LiveConnection` exposes bounded control operations and never exposes raw credentials.

### Placement provider

```ts
interface FabricBackendRouteResolver {
  prepare(request: {
    route: EndpointRouteHandle;
    workspace: WorkspaceBinding;
    attemptId: string;
  }, signal: AbortSignal): Promise<PreparedFabricBackendChannel>;
}
```

The Fabric-backed `TeammateBackend` adapter owns the mapping from `TeammateRunSpec` to this resolver. The teammate host remains the dispatch/recovery authority. The prepared channel must expose start acknowledgement, send/abort, early `onTurnComplete`, recovery facts, reclamation evidence, and one completion publisher. A selected route constrains endpoint/model capabilities; conflict fails instead of falling back to another endpoint.

### MCP mount provider

```ts
interface FabricMcpMountProvider {
  mount(route: EndpointRouteHandle, signal: AbortSignal): Promise<McpMountDescriptor>;
  validate(mountId: string, expectedRouteGeneration: number): Promise<void>;
  unmount(mountId: string): Promise<void>;
}
```

The descriptor contains endpoint identity, route generation, transport parameters, and credential references controlled by the host. The existing MCP adapter owns the actual client lifecycle.

## 6. Persistence boundaries

Fabric stores should be explicit interfaces. Initial Flow adapters may use existing atomic JSON stores, but contracts must not require a particular database.

| Record | Initial authority |
|---|---|
| Device/Connector/Endpoint registry | Fabric store adapted by Flow |
| Credential hash/revoke generation | existing Gateway PairingStore adapter |
| Workspace registration | device-local WorkspaceRegistry remains path authority; Fabric stores only device-qualified Hub ID mapping and redacted projection |
| Live connection | Fabric Connection Manager memory + durable last-known event |
| Workspace Binding | Fabric lease store |
| Route handle | short-lived signed/fenced record |
| Board authority | exactly one selected Board store; Fabric may index/attach but never become a second writer |
| Gateway Todo authority | existing Gateway workspace/session Todo, distinct from Board and Pi Todo |
| Pi Todo authority | origin Pi/workspace only; remote use is a qualified reference or read-only snapshot |
| Agent instance | teammate runtime; projected into Fabric presence |
| MCP session | existing MCP lifecycle manager |
| Invocation receipt | new endpoint-aware receipt interface following existing patterns; current Gateway receipt schema is not reused as proof of arbitrary MCP deduplication |
| Artifact bytes | source device initially; metadata/index may be Hub-owned |

No package may write another package's private state files directly.

## 7. Incremental extraction plan

### Phase 0 — documents and contract tests

- finalize vocabulary and invariants;
- inventory existing Gateway-control, teammate-runtime, SSH, and MCP data-channel contracts in a capability matrix;
- define workspace ID mapping, three task authorities, and per-entry compatibility mappings;
- lock authority and compatibility decisions before creating runtime code.

### Phase 1 — `pi-maestro-fabric-core` (implemented baseline)

- pure v1 records, protocol enums, bounded plain-JSON validation, explicit connected-to-ready transitions, and redacted allowlist projections are implemented;
- focused tests cover identifier/UTF-8 bounds, route generations, workspace binding, replay proof, state transitions, public exports, and dependency isolation;
- no transport, persistence, Gateway, teammate, or MCP runtime changes.

### Phase 2 — `pi-maestro-fabric` connection kernel

- explicit transport registry and host-authority seeding separated from connection-scoped advertisements;
- explicit connect, accepted-advertisement readiness, retryable disconnect, and one-current-generation-per-Connector fencing;
- deadline-scheduled shutdown drain plus bounded terminal metadata retention/compaction;
- revision-fenced Device/Connector authority and generation-high-water Workspace/Endpoint read models;
- separate generic adapters that preserve the actual host-owned Gateway-control and teammate-runtime fixed SSH handles;
- do not claim a generic remote MCP data path until its framing, identity, and route fencing are verified;
- Device/Connection/Workspace/Endpoint/Route runtime behavior remains the implemented Phase 2 boundary;
- no WSS and no Edge runtime yet.

### Phase 3 — Flow control surfaces

- add `device` and `endpoint` control tools;
- adapt existing `workspace` operations to connection-scoped bindings;
- project Fabric status into Monitor/TUI;
- keep legacy `ssh` behavior only for old schemas; Fabric-aware requests require explicit device connection, workspace binding where needed, endpoint selection, and `route.open`;
- reject Fabric fields from consumers that cannot validate their generation rather than silently ignoring them.

### Phase 4 — MCP mounts

- begin only after a route-bound MCP data channel and mount registration seam are verified;
- Fabric produces route-bound mount descriptors;
- existing MCP adapter mounts/unmounts them and revalidates the outer route on calls, lazy initialization, OAuth return, metadata refresh, and direct-tool dispatch;
- stale connection generations evict mounts;
- preserve current search/describe/call, OAuth, consent, and output guards.

### Phase 5 — teammate placement

- add a Fabric-backed `TeammateBackend` adapter; do not add a second placement authority;
- map route constraints to model/backend capabilities and reject conflicts;
- require start ACK, recovery facts, reclamation, and a unique completion publisher before remote fallback;
- preserve current local dispatch as the default;
- remote Todo IDs remain independent; central Board references are explicit;
- reuse current completion, Monitor, and `agent://` publication paths.

### Phase 6 — outbound WSS and Edge

- one-time Connector pairing and credential rotation;
- hello/ready/heartbeat/drain;
- Edge-managed device/endpoint advertisements;
- LAN direct route tickets and same-endpoint relay fallback;
- artifact chunking and optional Hub cache.

## 8. Compatibility policy

- Existing local teammate calls remain unchanged when placement is omitted.
- Existing `mcp` configured servers remain unchanged; Fabric mounts use a separate provider namespace.
- Existing `ssh` actions remain available for legacy request schemas. They do not satisfy Fabric connection-first execution; Fabric fields require the new explicit connection/binding/route path.
- Existing Gateway workspace permanent/lease semantics remain device-local and readable. Hub workspace IDs are separate, device-qualified identities mapped to local workspace IDs.
- Existing tunnel Quick/Named/OpenAI profiles remain Access Plane concerns.
- New fields are optional until all consumers understand the corresponding version.
- Compatibility projections are read-only where two authorities cannot safely mutate the same state.
- Existing MCP lazy connect remains valid for ordinary configured servers; Fabric mounts cannot use it to recreate an outer connection.
- Current Gateway operation receipts remain operation-specific. Arbitrary MCP mutation is non-replayable unless the endpoint proves durable deduplication.

## 9. Initial testing strategy

Each package owns tests at its boundary:

- Fabric Core: schema/state machine/property and compatibility fixtures.
- Fabric Runtime: connection races, generation invalidation, drain, transport faults, route stability, presence evidence.
- Flow adapters: Gateway auth/policy, workspace binding, SSH compatibility, Monitor projections, config migration.
- MCP integration: no implicit connect, mount eviction, auth/consent reuse, result conversion and output bounds.
- Teammate integration: placement validation, remote start/reclamation, DAG dependencies, completion delivery, Todo authority separation.
- Edge/WSS: reverse interleavings, reconnect, duplicate instance admission, heartbeat expiry, cancellation, artifact resume.

Passing evidence is reused across package gates unless relevant code, config, dependencies, generated declarations, or fixtures changed.

## 10. Locked boundaries for subsequent implementation

- Package names and dependency direction are fixed: pure public contracts live in `pi-maestro-fabric-core`; runtime adapters must not introduce reverse imports.
- Store technology is intentionally substitutable, but all adapters implement the five store authorities and canonical `shapeVersion: 1` read-boundary migration contract.
- Fabric wire envelopes remain `fabric.v1`; control, stream, mount, placement, artifact, store, and ticket shapes carry their own additive v1 discriminants.
- Direct routes require TLS and an opaque signed route-ticket proof. Cryptographic algorithms and key IO belong to host security adapters.
- Mount lifetime is one Pi session plus one route; reconnect or generation change revokes it.
- Artifacts are source-local unless admission explicitly selects `hub-cache`; fallback never changes this silently.
- V1 authorization targets one owner across multiple devices. Multi-tenant semantics require a future protocol version rather than optional ambiguous fields.

Later tasks implement these contracts; they do not reopen their authority, lifetime, replay, or trust decisions.