# Fabric Security v1

> Status: locked additive v1 contract. This document defines trust and validation boundaries, not cryptographic or network implementation.

## Trust boundaries

The Hub authenticates a Connector, but neither the Connector nor a LAN is automatically trusted for workspace or endpoint execution. Authorization is checked at admission and repeated at the device-local execution boundary. Connection, workspace, endpoint, route, mount, stream, and artifact generations are independent fences.

Fabric Core contains no secret IO, key storage, signing library, TLS implementation, Gateway runtime, Flow runtime, teammate runtime, or MCP SDK. Hosts register adapters for those concerns.

## Pairing and rotation

Pairing yields a Connector ID plus one rotatable credential. Enrollment requires possession of a short-lived token with audience `fabric`, an exact purpose scope, and a Connector binding. The Hub atomically records a single-use consumption tombstone with Connector/Device registration; knowledge of the pairing ID is not authorization. A domain-separated token verifier may remain private for bounded lost-response receipt recovery, which can return only an existing receipt.

For Ed25519 Connector credentials the private registry persists the canonical SPKI public key, its SHA-256 fingerprint, audience, operational scope, expiry/revoke state, and `credentialGeneration`. Private keys and raw tokens are never persisted there. A proof binds Connector ID, fresh process nonce, cryptographically random challenge nonce, selected protocol, audience, and credential generation. Rotation replaces the SPKI and increments the generation in one registry transaction. Old generations fail closed.

Raw credentials, private keys, persisted public-key material and fingerprints, token verifiers, route-ticket proofs, and credential references are excluded from public projections and safe events.

The Device CLI accepts enrollment and rotation tokens only on stdin. It derives fixed HTTPS registration and receipt routes plus the canonical WSS Connector route from a credential-free HTTPS origin, refuses redirects, and generates Ed25519 keys locally. The private key, pending-operation journal, and final Connector config are atomic private files; Windows installations apply and verify a protected owner-only ACL rather than relying on POSIX mode bits. An uncertain response leaves the old config active and the non-secret pending journal intact. Repeating the command with the same token performs receipt recovery only and never invents a second rotation.

Shutdown fences registration HTTP and new WSS admission before channel draining begins. Durable Connector revocation and physical cleanup are reported separately: `revoked-cleanup-pending` is retryable, and an exact revoke retry repeats cleanup without advancing the durable revision.

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
