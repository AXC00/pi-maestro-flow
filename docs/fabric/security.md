# Fabric Security v1

> Status: locked additive v1 contract. This document defines trust and validation boundaries, not cryptographic or network implementation.

## Trust boundaries

The Hub authenticates a Connector, but neither the Connector nor a LAN is automatically trusted for workspace or endpoint execution. Authorization is checked at admission and repeated at the device-local execution boundary. Connection, workspace, endpoint, route, mount, stream, and artifact generations are independent fences.

Fabric Core contains no secret IO, key storage, signing library, TLS implementation, Gateway runtime, Flow runtime, teammate runtime, or MCP SDK. Hosts register adapters for those concerns.

## Pairing and rotation

Pairing yields a Connector ID plus one rotatable credential. The Hub persists only a hash, audience, scopes, expiry, revoke state, and `credentialGeneration`. A proof binds Connector ID, fresh process nonce, challenge nonce, selected protocol, audience, and credential generation. Rotation commits the new hash and generation while revoking the predecessor in one store transaction. Old generations fail closed.

Raw credentials, hashes, signing keys, route-ticket proofs, and credential references are excluded from public projections and safe events.

## Route tickets

A direct path requires TLS and `FabricRouteTicketV1`. Claims are bound to:

- ticket/key/nonce identity;
- subject and audience;
- route, Device, Endpoint, and optional Workspace Binding;
- connection, endpoint, and optional workspace generations;
- one or more admitted operation classes;
- issue and expiry timestamps.

The `proof` is opaque to Fabric Core. A host security adapter selects and verifies the signature algorithm and key. Verification must occur before opening a direct data path and again before asynchronous commit/publication. Unknown ticket versions, empty operation classes, missing paired workspace fields, stale generations, malformed proof text, and expired claims fail closed.

`projectFabricRouteTicket` returns claims only. It never returns the proof.

## Local reauthorization

The Connector resolves device-local workspace identity and performs the final path/tool/policy authorization. Hub admission cannot override a local denial. Absolute paths, local owner tokens, process environments, MCP credentials, and browser profiles stay local.

## Replay and cancellation

A signed ticket authorizes a bounded operation class; it does not make work replayable. Automatic replay remains limited to readonly work or endpoint-proven durable deduplication. Cancellation acknowledgement means only that cancellation was admitted. Lost transport after possible acceptance remains `outcome-unknown` until the side-effect authority reconciles it.

## Locked v1 policy

- LAN direct routes always use TLS plus a short-lived route ticket.
- Mutual TLS may be required by a deployment adapter, but is not an alternate Core ticket shape.
- Credential and signing-key material never enter Fabric public records.
- Ticket fallback changes only an admitted path for the same route and Endpoint.
- Multi-tenant authority is outside v1; ambiguous tenant fields are not accepted as authorization.
