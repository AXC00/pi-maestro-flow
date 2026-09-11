# Fabric Edge and Data Paths v1

> Status: locked additive v1 contract. Edge discovery and network transport implementations are not part of Fabric Core.

## Managed topology

An Edge Connector may advertise multiple Devices and Endpoints. Connector presence does not imply that an Edge-managed Device or Endpoint is online; each subject needs current generation-bound presence evidence. V1 accepts only explicitly configured, allow-listed devices and services. Automatic LAN discovery is outside v1.

## Route paths

`FabricRoutePath` admits four names:

- `hub` — the established Hub-mediated path;
- `lan-direct` — a ticketed local data path;
- `edge-relay` — relay through the selected Edge Connector;
- `vps-relay` — relay through Hub infrastructure.

A route records optional additive `deviceId`, `operationClass`, `pathCandidates`, and `selectedPath`. When `selectedPath` is present it must occur in the unique non-empty candidates. A path switch uses revision-fenced compare-and-swap and may not change route, Device, Endpoint, or any generation.

## Direct admission

`lan-direct` requires an already admitted logical Fabric connection, current route, TLS, and a `FabricRouteTicketV1`. The ticket binds subject, audience, route/Device/Endpoint, generations, operation classes, and expiry. A direct connection never performs capability selection or endpoint fallback.

Failure may advance only to another pre-admitted candidate for the same endpoint. A new Device or Endpoint requires explicit selection and a new route.

## Stream channel

`FabricStreamChannel` is the host-neutral data-channel seam. Every `FabricStreamFrameV1` carries `fabric.stream.v1`, stream, route, operation, sequence, time, kind, and bounded plain-JSON payload. Frame kinds are `open`, `data`, `ack`, `end`, `cancel`, and `error`.

The interface intentionally exposes no WebSocket, Node stream, Flow, teammate, or MCP SDK type. Transport adapters own bytes and backpressure. Sequence zero is valid for opening a stream; negative, unsafe, unknown-version, unknown-kind, or non-JSON frames fail closed. An adapter must revalidate route generations before receiving work and before publishing an asynchronous result.

## Artifact transfer

Artifacts use descriptors plus independently digested bounded base64 chunks. A descriptor selects `source` or `hub-cache` explicitly. Source-local is the default policy; caching is never activated by network fallback. Resume uses artifact identity, byte offset, and chunk digest. It does not authorize a different route or source.

## Locked v1 policy

- Service inventory is allow-listed; multicast/automatic discovery is outside v1.
- Path fallback never changes target identity.
- Direct paths require TLS and route tickets.
- Stream framing is protocol-neutral and route-bound.
- Edge runtime, relay, cache, and network handlers belong outside Fabric Core.
