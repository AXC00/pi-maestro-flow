# Pi Maestro Multi-Device Fabric

> Status: initial architecture draft, revised after an Astra architecture review. This directory defines a target model for incremental refinement; it is not an implementation claim.
>
> Review result: **REVISE incorporated**. The first review tightened legacy connection entry points, outer Fabric versus inner MCP leases, Hub/local workspace identity, teammate recovery authority, MCP replay rules, the three task authorities, fixed SSH protocol boundaries, and dependency notation.

## Purpose

Pi Maestro needs to coordinate agents and MCP services across local machines, servers, cloud runtimes, and LAN edges without assuming that every device runs an agent. The Fabric introduces an explicit control layer above the existing Gateway, teammate, MCP adapter, Board, Todo, Monitor, SSH, and tunnel implementations.

The central rule is:

> Discover by capability, establish a connection to a selected device, bind an authorized workspace when required, select an endpoint, then execute through either `teammate` or `mcp`.

Capability resolution never executes work and never randomly selects a target.

## Core distinctions

| Concept | Meaning | Authority |
|---|---|---|
| Device | Managed machine or logical host | Identity, ownership, lifecycle |
| Connector | Network representative for one or more devices | Connection and route establishment |
| Connection | Generation-fenced live channel | Temporary communication authority |
| Workspace | Project/data boundary on one device | Path and operation authorization |
| Endpoint | Concrete execution target | Accepts delegation or MCP invocation |
| Capability | Searchable endpoint projection | Discovery only |
| Agent instance | One running teammate/agent execution | Task ownership and messaging |

A Windows workstation may publish both an Agent Runtime endpoint and an MCP endpoint. An MCP-only server publishes no Agent endpoint. A LAN Edge Connector may represent several devices and their MCP endpoints.

## Two model-visible actions

```text
Agent
├─ delegate ──> Agent Runtime Endpoint ──> Agent instance
└─ invoke   ──> MCP Endpoint ───────────> tool/resource
```

Infrastructure additionally uses a third, model-hidden protocol for registration, connection, heartbeat, route negotiation, and teardown.

## Connection-first execution

```text
registered
  -> connecting
  -> connected
  -> workspace_bound (when required)
  -> endpoint_ready
  -> executing
  -> draining/disconnected
```

No remote `teammate` dispatch or MCP call may implicitly connect, change devices, or silently replace an endpoint. A reconnect creates a new generation and invalidates prior workspace bindings and route handles.

## Documents

- [Architecture](./architecture.md) — concepts, state machines, data model, routing, and current tool integration.
- [Protocol v1](./protocol.md) — WSS framing, handshake, heartbeat, generation fencing, route admission, execution, cancellation, and recovery.
- [Persistence v1](./persistence.md) — registry, lease, presence, binding, route, mount, receipt, event, and atomicity boundaries.
- [Package boundaries](./package-boundaries.md) — isolated packages, dependency direction, compatibility adapters, and phased extraction.
- [Current Gateway tunnel configuration](../gateway-tunnel-configuration.md) — existing Cloudflare, OpenAI, and Managed OpenSSH ingress setup; not a Fabric transport contract.

Future documents should be added only when their contracts stabilize:

- `security.md` — pairing, route tickets, local reauthorization, and credential rotation.
- `edge.md` — LAN discovery, Edge-managed devices, direct routes, and relay fallback.
- `mcp-federation.md` — remote MCP mounting, metadata cache, content conversion, and artifacts.
- `teammate-placement.md` — remote placement, task ownership, completion, and monitoring.

## Existing capabilities to reuse

- Gateway pairing token hash, TTL, scope, audience, revoke, replacement, and generation fences.
- Device-local Workspace registry and permanent/lease registrations, exposed to the Hub only through a device-qualified projection.
- Collaborative Session CAS and member leases.
- Gateway operation-receipt patterns and event/result cursors; existing receipt schemas remain operation-specific.
- SSH fixed-command channels and host digest fencing.
- Gateway Session Launcher remote execution bindings.
- Teammate DAG dispatch, correlation IDs, completion durability, messaging, and endpoint projection.
- MCP adapter `status/server/search/describe/connect/tool` proxy and connection leases.
- Board, Gateway Todo, and Pi Todo as three separate authorities with qualified references rather than ID reuse.
- Persistent and Quick tunnel profiles.

## Non-goals for the first release

- Multi-tenant billing or organization hierarchy.
- Automatic semantic task planning in the control plane.
- Random capability-based execution placement.
- Replicating device workspaces, processes, browser sessions, or local Todo stores.
- Replacing current SSH, Gateway, teammate, or MCP public surfaces in one migration.
- Exposing every remote MCP tool as a permanent direct Pi tool.

## Initial package direction

Contracts and runtime should not be added directly to teammate or spread across Gateway and SSH modules. The proposed isolation is:

```text
pi-maestro-fabric-core   versioned pure contracts and validation
          ^
          |
pi-maestro-fabric        registries, connections, routes, transports
          ^
          |
pi-maestro-flow          Gateway/CLI/TUI/MCP/Board integration
```

`pi-maestro-teammate` may depend only on versioned Fabric contracts or receive a runtime-registered placement provider. Fabric must not statically import Flow or teammate internals.

Phase 2 now includes `packages/pi-maestro-fabric`: the host-independent in-memory directory, connection/admission kernel, explicit transport registry, and two fixed SSH channel seams are implemented on top of `pi-maestro-fabric-core`; Flow integration and Phase 3+ remain deferred.

See [Package boundaries](./package-boundaries.md) for the incremental migration.