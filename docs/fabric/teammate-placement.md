# Fabric Teammate Placement v1

> Status: locked additive v1 contract. Teammate remains dispatch, attempt, recovery, and completion authority.

## Adapter boundary

Remote placement is implemented later as a Fabric-backed `TeammateBackend` adapter. Fabric Core never imports teammate or Flow runtime types and never creates an AgentSession. Local teammate dispatch is unchanged when placement is omitted.

`TeammatePlacementV1` binds placement, route, Endpoint, connection/workspace/endpoint generations, optional qualified task reference, requested model/role/task type, and deadline. Requested capabilities constrain selection within the already chosen Endpoint. A conflict fails; fallback cannot silently choose another Endpoint.

`AgentPlacementRequest` retains the Phase 1 fields and adds optional `task` and `placement`, so old fixtures remain valid. When placement metadata is present, the validator requires its route identity, generations, and deadline to match the admitted request.

## Task authority

`QualifiedTaskReferenceV1` is `(authority, workspaceId, taskId)`, where authority is exactly `pi-todo`, `gateway-todo`, or `board`. Equal task IDs from different authorities are unrelated.

`QualifiedTaskSnapshotV1` is bounded read-only context: reference, subject, status, optional summary, and revision. It never grants mutation authority. Fabric does not mirror, alias, complete, or claim a referenced Todo or Board task.

At the teammate snapshot read/projection boundary, `validateWorkspaceTodoSnapshot` replaces CR/LF runs with one space and removes every other C0 control, ESC, and DEL. This follows `spec:project:architecture-constraints-071`; later renderers may repeat the sanitization as defense in depth.

## Lifecycle events

`FabricPlacementEventV1` uses monotonic sequence identity and one of:

- `start-ack`;
- `output`;
- `turn-complete`;
- `recovery-facts`;
- `reclamation`;
- `completion`;
- `error`.

Payloads are bounded plain JSON. The backend attaches turn-completion observation before output, preserves current message semantics, and publishes completion exactly once through the existing teammate publication authority.

## Recovery

Loss of transport does not prove an attempt stopped. Replacement requires durable recovery facts and confirmed reclamation from the teammate authority. A new Fabric route alone is insufficient. Unresolved work remains outcome-unknown and is never converted into successful completion or blindly replayed.

## Locked v1 policy

- Teammate owns DAGs, model routing, AgentSession lifecycle, messaging, reclamation, and publication.
- Fabric placement only constrains a previously admitted route and Endpoint.
- Task references are qualified and read-only across authorities.
- Local dispatch remains the default when placement is absent.
- Core contains no teammate or Flow runtime dependency.
