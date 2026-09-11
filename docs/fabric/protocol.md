# Multi-Device Fabric Protocol v1

> Status: v1 semantics and public framing contracts frozen. WSS, authentication, signing, storage, MCP, and teammate runtime implementations remain outside Fabric Core.

## 1. Protocol families

Fabric preserves three distinct protocols:

1. **Connector control** — registration, outbound WSS admission, advertisements, heartbeat, binding, route, drain, and recovery.
2. **Agent placement** — a selected Agent Endpoint is adapted to `TeammateBackend`; teammate remains attempt and completion authority.
3. **MCP invocation** — a selected MCP Endpoint is mounted temporarily; the existing MCP adapter remains client/session authority.

There is no generic operation that merges Agent delegation with MCP invocation.

## 2. WSS framing

A Connector initiates one outbound TLS-protected WebSocket to the Hub. Each WebSocket message is exactly one UTF-8 JSON object:

```ts
interface FabricEnvelopeV1 {
  version: "fabric.v1";
  messageId: string;
  kind: FabricMessageKind;
  sentAt: number;
  connectionId?: string;
  connectionGeneration?: number;
  correlationId?: string;
  operationId?: string;
  deadlineAt?: number;
  payload: object;
}
```

Rules:

- Reject a frame exceeding the negotiated byte limit before JSON parsing.
- Reject malformed JSON, arrays, non-object payloads, unknown versions, unknown message kinds, and invalid identifiers with `protocol_violation` or `invalid_argument`.
- A protocol violation is never converted to assistant output or successful completion.
- `messageId` deduplicates transport delivery only; it does not prove operation idempotency.
- `operationId` identifies one application operation. Replay still requires the operation's declared replay class and endpoint proof.
- `deadlineAt` is absolute Unix epoch milliseconds and is never extended by queueing or reconnect.
- Responses copy `correlationId` and, where present, `operationId`.
- Errors are bounded and omit credentials, route tickets, absolute paths, environment data, and raw remote output.

Peers negotiate these limits and use the stricter value:

```ts
interface FabricProtocolLimits {
  maxFrameBytes: number;
  maxInFlightOperations: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxAdvertisementItems: number;
  maxResultBytes: number;
}
```

`heartbeatTimeoutMs` must exceed `heartbeatIntervalMs`.

## 3. Message requirements

| Kind | Sender | Required envelope fields | Required payload fields | Valid state |
|---|---|---|---|---|
| `client_hello` | Connector | base | connector identity, instance nonce, credential generation, versions, digest, limits | new socket |
| `server_challenge` | Hub | correlation | challenge nonce, audience, expiry, selected version | hello accepted |
| `client_proof` | Connector | correlation | connector identity, instance nonce, challenge proof | challenge active |
| `connection_accepted` | Hub | connection + generation | lease, negotiated limits | proof accepted |
| `advertise_snapshot` | Connector | connection + generation | revision, Devices, Workspaces, Endpoints, Capabilities | connected |
| `advertise_delta` | Connector | connection + generation | base revision, next revision, upserts, removals | snapshot accepted |
| `ready` | Hub | connection + generation | advertisement revision, lease expiry | snapshot accepted |
| `heartbeat` | Connector | connection + generation | sequence, observedAt, endpoint evidence | ready |
| `heartbeat_ack` | Hub | connection + generation + correlation | sequence, lease expiry | ready |
| `workspace_bind` | either request/response | connection + generation + correlation | Device/Workspace IDs, generations, policy digest, expiry/result | ready |
| `route_open` | either request/response | connection + generation + correlation | Endpoint, binding when scoped, generations, operation class, expiry/result | ready/bound |
| `control_request` / `control_response` | caller / Hub | correlation + deadline | `FabricControlRequestV1` / safe bounded result | admitted state required by action |
| `stream` | either | connection + generation + operation | `FabricStreamFrameV1`, route, stream and sequence identity | route open |
| `invoke` | either request/event | connection + generation + operation + deadline | route identity and protocol-specific request/event | route open |
| `artifact` | source / caller | connection + generation + operation | descriptor or bounded base64 chunk | route open |
| `cancel` | either request/ack | connection + generation + operation + correlation | route ID, reason or acknowledgement state | operation known or unknown |
| `receipt` | either | connection + generation + operation | receipt revision, state, endpoint receipt/result reference | operation known |
| `drain` | either | connection + generation | reason, deadline | connected/ready |
| `close` | either | connection + generation | reason | any admitted state |
| `error` | either | correlation when available | stable code, safe message, optional path/retryable | any |

Unknown optional fields in `fabric.v1` may be ignored. Missing required fields are rejected. Each nested contract rejects an unknown version discriminant. Legacy Gateway/SSH/MCP envelopes remain unchanged at their existing entry points; Fabric identity fields opt a request into strict Fabric validation and cannot be silently ignored.

## 4. Pairing and handshake

Pairing is out-of-band bootstrap. It yields a Connector identity and rotatable credential. The Hub stores only its hash, scope, audience, expiry, revoke state, and generation.

```text
Connector -> Hub: client_hello
Hub       -> Connector: server_challenge
Connector -> Hub: client_proof
Hub       -> Connector: connection_accepted
Connector -> Hub: advertise_snapshot
Hub       -> Connector: ready
```

`client_hello` contains:

```ts
interface ClientHello {
  connectorId: string;
  connectorInstanceNonce: string;
  credentialGeneration: number;
  supportedVersions: readonly ["fabric.v1", ...string[]];
  capabilityDigest: string;
  limits: FabricProtocolLimits;
}
```

The instance nonce is fresh for each Connector process lifetime. Challenge proof binds Connector ID, instance nonce, challenge nonce, selected protocol, audience, and credential generation. Exact cryptography belongs in `security.md`; raw credentials never enter frames.

After valid proof, the Hub allocates a new `connectionId` and a strictly greater connection generation. A newer generation fences every older generation for that Connector. A connection cannot execute until the full snapshot is accepted and `ready` is emitted.

## 5. Advertisements

A Connector sends a full snapshot after admission and monotonic deltas afterward:

```text
advertise_snapshot { advertisementRevision, devices, workspaces, endpoints, capabilities }
advertise_delta    { baseRevision, advertisementRevision, upserts, removals }
```

A delta is accepted only when `baseRevision` equals the Hub revision for the same connection generation. A mismatch requests a full snapshot; the Hub never guesses missing changes. Applying an advertisement and replacing its Capability projections is atomic.

Workspace data contains Hub and device-local IDs plus redacted metadata, never absolute paths. Endpoint generation increases when executable identity or contract changes. Health-only changes belong to presence.

## 6. Heartbeat and presence

```text
heartbeat     { sequence, observedAt, endpointHealth? }
heartbeat_ack { sequence, leaseExpiresAt }
```

`sequence` is strictly increasing within one connection generation. A valid heartbeat renews only that generation's lease. Missing acknowledgement causes the Connector to reconnect; missing heartbeat causes the Hub to expire the lease.

Registry presence, Connector connectivity, Device reachability, and Endpoint health are separate facts. Timestamps are last-known evidence, not proof that a target is currently executable.

## 7. Workspace binding

A workspace-scoped Endpoint requires an explicit binding after `ready`:

```text
workspace_bind {
  connectionId,
  connectionGeneration,
  deviceId,
  workspaceId,
  localWorkspaceId,
  expectedWorkspaceGeneration,
  requestedTtlMs
}
```

The Connector resolves `localWorkspaceId` and reauthorizes locally. A successful binding records both connection and workspace generations plus policy digest. Reconnect, local re-registration, policy change, expiry, or revoke invalidates it. Renewal may extend only the same generations and digest.

## 8. Endpoint selection and route admission

Capability resolution returns candidates and reasons but does not connect or execute. The caller explicitly selects a Device and Endpoint, then sends `route_open`.

Admission checks:

- current ready connection and generation;
- Device ownership by the connection's Connector;
- selected Endpoint identity, kind, status, contract, and generation;
- current Workspace Binding for workspace-scoped Endpoints;
- subject, policy, deadline, operation class, and negotiated path.

The result is an authority-bearing `EndpointRouteHandle` containing route, connection, optional binding, Endpoint, all generations, state, revision, and expiry.

A LAN route additionally uses a short-lived signed ticket bound to subject, audience, Device, Endpoint, route generations, allowed operation class, and expiry. Route fallback may change only a pre-negotiated network path for the same route and Endpoint; it may not change Device or Endpoint.

## 9. Generation fencing

Every stateful execution boundary validates:

```text
connectionId + connectionGeneration
workspaceBindingId + workspaceGeneration (when scoped)
endpointId + endpointGeneration
routeId
operationId (for application operations)
```

Validation occurs before execution and again before asynchronous commit/publication. A generation mismatch is terminal for that handle. Clients return to explicit connect/bind/route admission; inner protocol reconnects cannot recreate an outer Fabric connection.

## 10. Agent placement

An Agent route is adapted to the existing `TeammateBackend` lifecycle:

```text
start -> start_ack
send -> turn/result events
abort -> abort_ack
recover -> recovery facts
reclaim -> reclamation evidence
complete -> exactly one authoritative publication
```

The selected route constrains models/backends to capabilities advertised by that Endpoint. Conflicts fail; fallback never changes Endpoint. `onTurnComplete` is attached before output. Lost transport does not prove the attempt stopped. A replacement attempt requires real recovery facts and confirmed reclamation. Outcome-unknown work is not converted into success or safe replay.

## 11. MCP invocation

An MCP route creates a provider-managed temporary mount. Fabric connection/workspace/route is the outer lease; the MCP client connection is a separate inner lease.

Every list, describe, call, OAuth return, lazy initialization, metadata refresh, direct-tool dispatch, cancel, and result publication validates the outer generation. The inner client may reconnect only while the outer route remains open.

```ts
type ReplayClass = "readonly" | "durable-dedup" | "non-replayable";
```

- `readonly` may retry before deadline if no generation changes.
- `durable-dedup` requires Endpoint proof that side effect and receipt are atomically committed under `operationId`.
- `non-replayable` never retries automatically.
- Transport loss after possible acceptance yields `outcome-unknown` unless the endpoint receipt authority resolves it.
- Tool lookup is restricted to the selected mount; there is no first-match fallback across mounts.

## 12. Cancellation and deadlines

```text
cancel request { operationId, routeId, reason, requestedAt }
cancel ack     { operationId, state: "accepted" | "already-terminal" | "unknown" }
```

Cancellation is best effort and generation-fenced. `accepted` means cancellation was admitted, not that side effects were rolled back. Deadline expiry may trigger cancellation but remains distinct from confirmed `cancelled`. A result may race with cancellation; the authoritative receipt revision determines the terminal outcome.

## 13. Receipts and recovery

Receipt states are monotonic:

```text
accepted -> running -> succeeded | failed | cancelled | outcome-unknown
outcome-unknown -> succeeded | failed | cancelled  // only authoritative reconciliation
```

The Hub can prove routing facts only. Durable replay proof belongs to the authority that owns the side effect.

After reconnect:

1. establish a new instance nonce and connection generation;
2. keep old bindings, routes, mounts, and handles invalid;
3. query authoritative receipts/recovery facts by operation ID;
4. resume only readonly or endpoint-proven deduplicated work;
5. leave every other unresolved mutation as `outcome-unknown`.

## 14. Drain and close

`drain` stops new bindings and routes while allowing bounded in-flight completion. At its deadline the Hub fences the generation and closes the channel. `close` is idempotent and records a safe reason. Abrupt loss follows the same fencing rules without claiming graceful cancellation.

## 15. Stable errors

```text
invalid_argument, unsupported_version, unauthenticated,
permission_denied, not_found, conflict, stale_generation,
invalid_state, expired, resource_exhausted, deadline_exceeded,
cancelled, outcome_unknown, unavailable, protocol_violation
```

Errors carry a bounded safe message and optional field path. They never carry secrets or unbounded remote content.
