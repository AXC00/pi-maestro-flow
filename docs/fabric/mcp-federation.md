# Fabric MCP Federation v1

> Status: locked additive v1 contract. The existing Flow MCP adapter remains the only MCP client/session authority.

## Separation of authority

Fabric admits a selected MCP Endpoint and issues a route-bound mount descriptor. It does not implement MCP transport, OAuth, consent, sampling, elicitation, content conversion, UI resources, or direct tools. Those remain in the existing MCP adapter.

The Fabric route is the outer lease. The MCP client connection is an inner lease. Reconnecting the inner client cannot create, renew, or replace the outer route.

## Mount lease

`FabricMountLeaseV1` binds:

- one `mountId`, Pi `sessionId`, route, connection, and Endpoint;
- optional Workspace Binding plus its paired workspace generation;
- connection and endpoint generations;
- provider namespace, projected server name, and transport;
- issue/expiry, state, and revision;
- an optional host-private `credentialRef`.

States are `active`, `revoking`, and `closed`. V1 lifetime is exactly one Pi session plus one route. Sharing across sessions requires a future contract version. Multiple callers in the same session may reference-count only an identical route and generation tuple.

`projectFabricMount` removes `credentialRef`. Fabric mounts use a dedicated provider namespace and never become ordinary permanent MCP configuration.

## Validation boundaries

Discovery, list, describe, call, lazy initialization, metadata refresh, OAuth return, direct-tool dispatch, cancel, and result publication all revalidate the outer mount and route. Expiry or generation mismatch first removes discovery and cache visibility, then closes the inner client, then marks the mount closed. No first-match lookup across mounts is allowed.

Unknown versions, missing identity, unpaired workspace fields, invalid state/revision, and expired active/revoking leases fail closed.

## Replay and receipts

MCP calls retain the three replay classes:

- `readonly` may retry before deadline while generations remain current;
- `durable-dedup` requires Endpoint proof that side effect and receipt commit atomically under `operationId`;
- `non-replayable` never retries automatically.

Hub receipts prove routing facts only. Possible acceptance followed by transport loss produces `outcome-unknown` until the Endpoint authority resolves it.

## Artifacts

Large results may use `FabricArtifactDescriptorV1` and `FabricArtifactChunkV1`. Descriptors bind artifact/operation/route/Device/Endpoint identity, generations, media type, length, digest, storage, state, and lifetime. `sourceRef` stays host-private and is removed by `projectFabricArtifact`. Metadata remains bounded plain JSON and is deep-cloned by public projection.

Chunks are at most 1 MiB of decoded data, use canonical base64, carry offset/length/digest, and identify the final chunk. Consumers verify descriptor length and digest after assembly. Core defines validation only; it performs no file or network IO.

## Locked v1 policy

- One session and one route own a mount.
- Inner auto-connect never recreates outer authority.
- Source-local artifact storage is default; `hub-cache` must be explicit.
- Existing configured MCP servers and their lazy connection behavior remain unchanged.
