# Multi-Device Fabric Persistence v1

> Status: v1 authority and durability baseline. The core package defines records and invariants only; storage adapters belong to `pi-maestro-fabric` or `pi-maestro-flow`.

## 1. Principles

1. Persist authority, identity, policy, and recovery evidence; do not persist live sockets as if they were durable truth.
2. Each record has exactly one write authority.
3. Every mutation uses a monotonic revision or generation fence.
4. Writes that establish an invariant are atomic at that invariant's authority boundary.
5. Hub records never contain remote absolute workspace paths or raw credentials.
6. Connection loss never converts an unknown remote side effect into success or safe replay.
7. Pi Todo, Gateway Todo, and Board remain separate stores and identities.

## 2. Store groups

The runtime may use files, SQLite, or another database. These logical stores are required regardless of implementation:

```text
RegistryStore
  connectors / devices / workspaces / endpoints / capability projections

LeaseStore
  connection leases / workspace bindings / route records / MCP mount leases

PresenceStore
  last accepted heartbeat and endpoint health evidence

InvocationStore
  routing receipts / endpoint receipt references / recovery state

EventStore
  append-only bounded events and consumer cursors
```

The first implementation may co-locate stores in one atomic JSON document, but APIs must preserve these authority boundaries. `FabricStoreKind` freezes their API names as `registry`, `lease`, `presence`, `invocation`, and `event`. Every mutation is expressed as a `FabricStoreTransactionV1`; safe redacted changes use `FabricStoreEventV1`, and consumers checkpoint with `FabricStoreCursorV1`.

### 2.1 Persisted shape migration

Canonical persisted state writes `shapeVersion: 1`, `storeKind`, `revision`, `events`, and `cursors`. `migrateFabricPersistedStoreState` is the read boundary: it accepts the Phase 0-2 legacy single `cursor` field, validates every nested event/cursor, and returns a fresh canonical v1 shape. Writers never emit the legacy form.

Update semantics distinguish omitted, empty, and invalid values. An omitted legacy cursor migrates to `cursors: []`; an explicitly present cursor is preserved as the single array element. V1 requires the `cursors` array even when empty. Unknown `shapeVersion`, missing required fields, store-kind disagreement, invalid revision/sequence, and out-of-bound JSON fail closed. No adapter may repair malformed state after it has crossed the read boundary.

## 3. Registry records

### 3.1 Connector registry

Durable fields:

```text
connectorId, label, enabled, transport, keyId,
publicKeySpki (canonical), publicKeyFingerprint,
credentialGeneration, scopes, audience, createdAt, updatedAt, revision
```

Ephemeral fields such as socket handles and current process nonce are not part of the registry record. For the Ed25519 Gateway adapter, SPKI is verification-key material rather than a credential secret, but remains private registry data and never enters public projections or events. Credential rotation atomically commits the replacement SPKI/fingerprint and increments `credentialGeneration`; old generations fail admission. Pairing consumption tombstones and immutable request-digest receipts remain durable independently of the store's bounded transaction ledger.

### 3.2 Device registry

Durable fields:

```text
deviceId, connectorId, label, connectionMode,
platform projection, enabled, createdAt, updatedAt, revision
```

A Device ID is globally unique within one Fabric authority. Moving a Device to another Connector is an explicit revision-fenced mutation and invalidates its current connection, bindings, Endpoint routes, and presence.

The strict `fabric.connector-config.v1` Device-side document may carry registered `devices`, one `localDeviceId`, and explicit `workspaceIds`. New enrollment output always carries all three; an empty workspace list exports none. Legacy v1 files without these fields remain status-readable, but cannot start a Connector until the operator enrolls or upgrades the identity metadata.

Device-side enrollment uses a private atomic pending journal containing only request identity/digest, public request data, and local file references. It never stores the purpose token. The active config is published only after an active durable receipt; rotation therefore keeps the predecessor config active across uncertain responses. Temporary files are fsynced before rename and the containing directory is synchronized where the platform supports directory handles.

### 3.3 Workspace directory

The Hub stores:

```text
workspaceId, deviceId, localWorkspaceId, label, mode,
generation, policyDigest, endpointIds, revision
```

It never stores `path` or `canonicalPath`. The device-local WorkspaceRegistry remains authoritative for path resolution, local owner token, and local lease. The pair `(deviceId, localWorkspaceId)` is unique; `workspaceId` is a separate opaque Hub identity.

Local re-registration that changes path identity, owner, policy, or generation is projected as a generation change and invalidates every Hub binding for that workspace.

### 3.4 Endpoint registry

Durable Endpoint metadata includes identity, kind, Device/Connector ownership, scope, generation, contract hash, enabled state, and redacted capability descriptors. Process IDs, stdio commands, access tokens, and absolute paths stay device-local.

Replacing an executable process or changing its externally observable contract increments `endpointGeneration`. Pure health changes update presence, not registry generation.

### 3.5 Capability index

Capability rows are derived projections of Endpoint advertisements. The Endpoint registry is authoritative. Index replacement is atomic per accepted advertisement revision; partial delta application is never externally visible. Removing an Endpoint removes its capabilities in the same transaction.

## 4. Connection leases

A live connection has two representations:

- an in-memory transport owner containing the socket/channel;
- a durable lease/evidence record containing identity, generation, state, expiry, and last transition reason.

```ts
interface StoredConnectionLease {
  connectionId: string;
  connectorId: string;
  connectorInstanceNonce: string;
  generation: number;
  state: "connecting" | "connected" | "draining" | "closed";
  capabilityDigest: string;
  establishedAt?: number;
  expiresAt: number;
  revision: number;
}
```

A durable `connected` record after process restart is only last-known evidence. Recovery first marks unreconciled leases expired/closed; it never reconstructs a live connection without a new handshake and generation.

Admission atomically:

1. checks credential and prior generation;
2. allocates the next generation and connection ID;
3. fences any previous active generation;
4. writes the new lease;
5. appends a connection event.

The transport becomes executable only after that transaction and protocol `ready` complete.

## 5. Presence

Presence is a last-known observation:

```ts
interface PresenceRecord {
  subjectKind: "connector" | "device" | "endpoint";
  subjectId: string;
  connectionId: string;
  connectionGeneration: number;
  sequence: number;
  status: "unknown" | "online" | "degraded" | "offline";
  observedAt: number;
  expiresAt: number;
  evidenceRevision: number;
}
```

Acceptance requires the current connection generation and a strictly increasing heartbeat sequence. The PresenceStore atomically updates the record and appends its event. Expiry changes the projection to offline but does not delete registry objects.

Connector online status must not automatically mark every Device or Endpoint online. Edge-managed targets need their own current evidence.

## 6. Workspace bindings

A Workspace Binding is a short-lived authorization lease, not a registry alias:

```text
bindingId, connectionId, deviceId, workspaceId,
connectionGeneration, workspaceGeneration, policyDigest,
issuedAt, expiresAt, revision, revokedAt?
```

Issue/renew checks both the Hub WorkspaceRecord and current device-local authorization response. A binding is invalid when any referenced generation or policy digest differs, even before its wall-clock expiry.

Renewal atomically verifies expected revision and unchanged generations before extending expiry. Reconnect and workspace re-registration bulk-fence affected bindings by generation; they need not be individually rewritten before validation starts rejecting them.

## 7. Route records and tickets

A route record persists admission metadata:

```text
routeId, connectionId, workspaceBindingId?, endpointId,
connectionGeneration, workspaceGeneration?, endpointGeneration,
subject, operationClass, pathCandidates, selectedPath,
issuedAt, expiresAt, revision, state
```

Route tickets are signed bearer capabilities and must not be stored in public registry/event records. Stores may retain a ticket hash, key ID, and expiry for revoke/audit. Route renewal cannot change Device or Endpoint; such a change requires a new explicit selection and route.

Changing only the pre-negotiated network path uses revision-fenced compare-and-swap on the same route. It cannot alter endpoint identity or generation.

## 8. MCP mount lifetime

Fabric mount state and MCP client state are separate:

```text
FabricMountLease
  mountId, routeId, route generations, MCP server projection name,
  issuedAt, expiresAt, revision, state

McpClientLease
  owned by existing MCP adapter; references mountId and expected route generation
```

Initial v1 lifetime is **per Pi session and route**. Sharing mounts between sessions is deferred. Multiple callers inside one session may reference-count the same mount only when route identity and generations are identical.

Every asynchronous boundary revalidates `FabricMountLease`. On expiry or generation change, the mount enters revoking, disappears from discovery, invalidates metadata/direct-tool caches, closes the inner MCP client, then becomes closed. Inner MCP auto-connect cannot renew or recreate the outer mount.

## 9. Invocation receipts

The Hub's InvocationStore owns routing facts, not remote side effects:

```ts
interface InvocationReceipt {
  operationId: string;
  routeId: string;
  endpointId: string;
  connectionGeneration: number;
  endpointGeneration: number;
  state: "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "outcome-unknown";
  replayClass: "readonly" | "durable-dedup" | "non-replayable";
  endpointReceiptRef?: string;
  resultRef?: string;
  revision: number;
  updatedAt: number;
}
```

`operationId` is unique within the InvocationStore authority. Duplicate admission returns the existing receipt when route/Endpoint identity matches and rejects a conflict otherwise.

Receipt transitions are monotonic and compare-and-swap protected. A success/failure result and its `resultRef` become visible atomically. A Hub receipt may record `durable-dedup` only when Endpoint registry metadata identifies a validated endpoint receipt contract. Otherwise mutating work is `non-replayable`.

Transport loss after possible acceptance atomically records `outcome-unknown` unless the endpoint receipt authority resolves a terminal state. The Hub cannot overwrite `outcome-unknown` with a guessed failure or success.

## 10. Agent attempt recovery

Fabric persists route and transport evidence. Teammate remains authoritative for attempt lifecycle:

```text
attemptId / correlationId / backend registration
start acknowledgement
last accepted remote sequence
completion publication reference
recovery facts reference
reclamation state
```

These fields are stored through the existing teammate completion/recovery authority or referenced by ID; Fabric does not create a parallel AgentAttempt store.

After connection loss, Fabric reports facts such as last acknowledged send, last received sequence, route generation, and receipt references. Only the `TeammateBackend` host adjudicates replay and fallback. A new route does not imply the old attempt was reclaimed.

## 11. Task authority references

Task references are qualified:

```ts
interface QualifiedTaskReference {
  authority: "pi-todo" | "gateway-todo" | "board";
  workspaceId: string;
  taskId: string;
}
```

- Pi Todo writes stay with the originating Pi session/workspace.
- Gateway Todo writes stay with its Gateway workspace/session authority.
- Board writes stay with exactly one selected Board store.
- Fabric may index references or carry bounded read-only snapshots. It never aliases equal-looking task IDs or becomes a second writer.

Board plan bindings and completion gates keep their existing authority-specific semantics.

## 12. Events and cursors

Registry, lease, presence, route, and invocation mutations append bounded events in the same atomic transaction as their authoritative state change.

```text
sequence, eventId, eventKind, subjectId, subjectRevision,
occurredAt, safe projection payload
```

Consumers persist cursors independently. Cursor advancement is atomic per consumer but is not coupled to processing side effects; consumers must be idempotent by `eventId` and subject revision. Compaction retains a snapshot plus a replay boundary.

Events contain redacted projections only. Credential hashes, route tickets, local paths, raw MCP arguments/results, and environment data are excluded.

## 13. Atomicity matrix

| Mutation | Must commit atomically |
|---|---|
| Connector credential rotation | hash + generation + revoke predecessor + event |
| Connection admission | next generation + prior fence + lease + event |
| Advertisement snapshot/delta | registry changes + capability index + advertisement revision + event batch |
| Workspace bind/renew | referenced generations/policy check + binding revision/expiry + event |
| Route open/path switch | route identity/generations + selected allowed path + event |
| Presence heartbeat | monotonic sequence + expiry + projection + event |
| Invocation admission | operation uniqueness + initial receipt + event |
| Invocation terminal result | terminal state + result/endpoint receipt reference + event |
| MCP mount revoke | mount state + discovery removal/cache generation + event |

Cross-authority operations use prepare/acknowledge and recovery, not an imaginary distributed transaction. Until both sides confirm, the caller sees pending or outcome-unknown rather than success.

## 14. Optimistic concurrency

Every durable mutable record has `revision: number`. Mutation requests carry `expectedRevision`; creation uses an absent-key precondition. Generation changes represent identity/lifetime fences, while revision changes represent updates within one generation. They are not interchangeable.

Conflicts return current safe metadata so callers can re-read and decide. Stores never implement last-write-wins for credentials, connection admission, binding, route, or receipt state.

## 15. Recovery order

On Hub restart:

1. load and validate registry snapshots;
2. mark unreconciled live connection leases expired/closed;
3. make old bindings, routes, and mounts unavailable through generation validation;
4. rebuild capability indexes from accepted registry projections;
5. replay event journal after the snapshot boundary;
6. reconcile non-terminal invocation receipts with endpoint authorities when connections return;
7. expose unresolved mutating work as `outcome-unknown`;
8. resume cursor delivery.

On Connector restart, a new instance nonce and connection generation are mandatory. The Connector sends a full advertisement snapshot before `ready`.

## 16. Retention and deletion

- Registry tombstones remain long enough to reject stale advertisements and route handles.
- Expired leases may be compacted after their audit/recovery window.
- Invocation receipts live at least through the maximum retry and operator-adjudication window.
- Event logs compact only after all required durable consumers pass the snapshot boundary.
- Deleting a Device first disables new admissions, drains/fences connections, invalidates bindings/routes, tombstones Endpoints, then removes redacted registry projections according to retention policy.

## 17. Public projections

Public status APIs expose IDs, labels, kinds, lifecycle states, generations, safe timestamps, health, and bounded error codes. They omit:

- credential material and hashes;
- Connector instance nonces;
- local workspace IDs and paths;
- route tickets and credential references;
- raw MCP arguments/results;
- process/environment details.

Projection functions belong in `pi-maestro-fabric-core`; store implementations must use them rather than hand-copying private records.
