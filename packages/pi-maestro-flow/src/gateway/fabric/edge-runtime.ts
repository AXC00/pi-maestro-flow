import { createHash } from "node:crypto";
import {
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidFabricRouteTicket,
  type DeviceId,
  type EndpointId,
  type EndpointRouteHandle,
  type FabricRoutePath,
  type FabricRouteTicketClaimsV1,
  type FabricRouteTicketV1,
  type JsonValue,
  type FabricReplayClass,
  type RouteId,
  type WorkspaceBindingId,
} from "pi-maestro-fabric-core/v1";
import type { FabricAdmissionManager, FabricRouteValidator } from "pi-maestro-fabric";
import {
  requireAllowedEdgeDevice,
  requireAllowedEdgeEndpoint,
  requireAllowedEdgeWorkspace,
  type FabricEdgeConfigV1,
} from "./edge-config.ts";
import { FabricRouteTicketSecurity, type FabricRouteTicketExpectation } from "./route-ticket.ts";

export const FABRIC_EDGE_SUBJECT_KINDS = ["connector", "device", "endpoint", "workspace"] as const;
export type FabricEdgeSubjectKind = (typeof FABRIC_EDGE_SUBJECT_KINDS)[number];

/** One independently observable subject. Presence is per subject, never implied. */
export interface FabricEdgeSubjectV1 {
  readonly kind: FabricEdgeSubjectKind;
  readonly deviceId?: DeviceId;
  readonly endpointId?: EndpointId;
  readonly workspaceBindingId?: WorkspaceBindingId;
}

export interface FabricEdgePresenceV1 {
  readonly subjectKey: string;
  readonly generation: number;
  readonly online: boolean;
  readonly observedAt: number;
}

export interface FabricEdgeAdvertisementV1 {
  readonly advertisementRevision: number;
  readonly capabilityDigest: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

/** Online Hub confirmation. A ticket the Edge minted is not authority on its own. */
export interface FabricEdgeHubTicketConfirmation {
  confirm(ticket: FabricRouteTicketV1, expectation: FabricRouteTicketExpectation): Promise<FabricRouteTicketClaimsV1>;
}

export interface FabricEdgeRuntimeOptions {
  readonly config: FabricEdgeConfigV1;
  readonly tickets: FabricRouteTicketSecurity;
  /** Current route authority: routes and generations are revalidated, never assumed. */
  readonly routes: FabricRouteValidator;
  readonly admissions: Pick<FabricAdmissionManager, "switchRoutePath">;
  readonly confirmWithHub?: FabricEdgeHubTicketConfirmation;
  readonly now?: () => number;
}

export interface FabricEdgeRouteTicketRequest {
  readonly routeId: RouteId;
  readonly subject: string;
  readonly ttlMs?: number;
}

export interface FabricEdgePathAdvance {
  readonly routeId: RouteId;
  readonly expectedRevision: number;
  /** The path that failed. Only it may be left behind. */
  readonly failedPath: FabricRoutePath;
  /** Automatic advancement is limited to readonly work or endpoint-proven deduplication. */
  readonly replayClass: FabricReplayClass;
}

/** Replay classes that may be handed to another admitted path without endpoint proof. */
const AUTOMATICALLY_ADVANCEABLE: readonly FabricReplayClass[] = ["readonly", "durable-dedup"];

/**
 * Canonical subject key.
 *
 * Each kind carries exactly the identity that makes it distinct, so a Device
 * presence record can never be read as an Endpoint one.
 */
export function fabricEdgeSubjectKey(subject: FabricEdgeSubjectV1): string {
  switch (subject.kind) {
    case "connector":
      if (subject.deviceId !== undefined || subject.endpointId !== undefined || subject.workspaceBindingId !== undefined) {
        throw new FabricContractError("invalid_argument", "A connector subject carries no Device, Endpoint, or Workspace", "kind");
      }
      return "connector";
    case "device":
      assertFabricIdentifier(subject.deviceId, "deviceId");
      return `device\u0000${subject.deviceId}`;
    case "endpoint":
      assertFabricIdentifier(subject.deviceId, "deviceId");
      assertFabricIdentifier(subject.endpointId, "endpointId");
      return `endpoint\u0000${subject.deviceId}\u0000${subject.endpointId}`;
    case "workspace":
      assertFabricIdentifier(subject.deviceId, "deviceId");
      assertFabricIdentifier(subject.workspaceBindingId, "workspaceBindingId");
      return `workspace\u0000${subject.deviceId}\u0000${subject.workspaceBindingId}`;
    default:
      throw new FabricContractError("invalid_argument", "Unsupported Edge subject kind", "kind");
  }
}

function sameRouteIdentity(left: EndpointRouteHandle, right: EndpointRouteHandle): boolean {
  return left.routeId === right.routeId
    && left.connectionId === right.connectionId
    && left.deviceId === right.deviceId
    && left.endpointId === right.endpointId
    && left.workspaceBindingId === right.workspaceBindingId
    && left.connectionGeneration === right.connectionGeneration
    && left.workspaceGeneration === right.workspaceGeneration
    && left.endpointGeneration === right.endpointGeneration;
}

/**
 * Edge Connector runtime for allowlisted Devices and Endpoints.
 *
 * It owns the local allowlist, generation-bound presence, ticket issuance, and
 * same-Endpoint path advancement. It performs no discovery: the only targets it
 * can name are the ones its configuration already names.
 */
export class FabricEdgeRuntime {
  readonly #options: FabricEdgeRuntimeOptions;
  readonly #now: () => number;
  readonly #presence = new Map<string, FabricEdgePresenceV1>();
  #advertisementRevision = 0;
  #advertisementDigest = "";

  constructor(options: FabricEdgeRuntimeOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get config(): FabricEdgeConfigV1 {
    return this.#options.config;
  }

  /**
   * Allowlisted inventory. It carries no local path and no key material.
   * Shape-compatible with the Connector runtime's advertisement source.
   */
  advertisementOf(): FabricEdgeAdvertisementV1 {
    const payload = this.#inventoryPayload();
    const digest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    if (digest !== this.#advertisementDigest) {
      this.#advertisementDigest = digest;
      this.#advertisementRevision += 1;
    }
    return { advertisementRevision: this.#advertisementRevision, capabilityDigest: digest, payload };
  }

  /**
   * Record one subject's generation-bound observation.
   *
   * A stale generation cannot lower a newer one: presence is evidence about a
   * specific generation, not a monotone heartbeat for the Device.
   */
  recordPresence(subject: FabricEdgeSubjectV1, generation: number, online: boolean): FabricEdgePresenceV1 {
    const key = fabricEdgeSubjectKey(subject);
    assertGeneration(generation, "generation");
    this.#assertAllowedSubject(subject);
    const existing = this.#presence.get(key);
    if (existing !== undefined && generation < existing.generation) {
      throw new FabricContractError("stale_generation", "Presence evidence names a superseded generation", "generation");
    }
    const record: FabricEdgePresenceV1 = { subjectKey: key, generation, online, observedAt: this.#now() };
    this.#presence.set(key, record);
    return { ...record };
  }

  presenceOf(subject: FabricEdgeSubjectV1): FabricEdgePresenceV1 | undefined {
    const record = this.#presence.get(fabricEdgeSubjectKey(subject));
    return record === undefined ? undefined : { ...record };
  }

  /**
   * Whether one Endpoint is online at exactly this generation.
   *
   * Connector presence is a different subject key, so a live Connector with no
   * Endpoint evidence reports offline rather than optimistically online.
   */
  endpointOnline(deviceId: DeviceId, endpointId: EndpointId, generation: number): boolean {
    assertGeneration(generation, "generation");
    const record = this.presenceOf({ kind: "endpoint", deviceId, endpointId });
    return record !== undefined && record.online && record.generation === generation;
  }

  /**
   * Mint a ticket for one already-admitted route.
   *
   * The route is re-read from the current authority, so a stale handle cannot
   * mint a ticket for a superseded generation.
   */
  issueRouteTicket(request: FabricEdgeRouteTicketRequest): FabricRouteTicketV1 {
    assertFabricIdentifier(request.routeId, "routeId");
    assertBoundedString(request.subject, "subject", 256);
    const config = this.#options.config;
    const route = this.#options.routes.validateRoute(request.routeId);
    const deviceId = route.deviceId;
    const operationClass = route.operationClass;
    if (deviceId === undefined || operationClass === undefined) {
      throw new FabricContractError("permission_denied", "An Edge route must name a Device and an operation class", "routeId");
    }
    if (route.selectedPath === undefined) {
      throw new FabricContractError("permission_denied", "An Edge route must have a selected path", "selectedPath");
    }
    requireAllowedEdgeDevice(config, deviceId);
    const endpoint = requireAllowedEdgeEndpoint(config, deviceId, route.endpointId);
    if (!endpoint.operationClasses.includes(operationClass)) {
      throw new FabricContractError("permission_denied", "Endpoint does not admit this operation class", "operationClass");
    }
    if (!config.pathCandidates.includes(route.selectedPath)) {
      throw new FabricContractError("permission_denied", "Route path is not admitted by this Edge", "selectedPath");
    }
    if (route.workspaceBindingId !== undefined) {
      requireAllowedEdgeWorkspace(config, deviceId, route.workspaceBindingId);
    }
    if (!this.endpointOnline(deviceId, route.endpointId, route.endpointGeneration)) {
      throw new FabricContractError(
        "unavailable",
        "Endpoint has no current online presence at this generation",
        "endpointId",
      );
    }
    const ttlMs = request.ttlMs ?? config.ticketTtlMs;
    return this.#options.tickets.issue({
      subject: request.subject,
      audience: config.audience,
      routeId: route.routeId,
      deviceId,
      endpointId: route.endpointId,
      ...(route.workspaceBindingId === undefined ? {} : { workspaceBindingId: route.workspaceBindingId }),
      connectionGeneration: route.connectionGeneration,
      ...(route.workspaceGeneration === undefined ? {} : { workspaceGeneration: route.workspaceGeneration }),
      endpointGeneration: route.endpointGeneration,
      operationClasses: [operationClass],
      ttlMs,
    });
  }

  /**
   * Confirm a ticket with the Hub over the network.
   *
   * The Edge re-checks its own allowlist afterwards: Hub admission decides
   * whether the route exists, but it can never widen what this device allows.
   */
  async validateRouteTicketOnline(
    ticket: unknown,
    expectation: FabricRouteTicketExpectation,
  ): Promise<FabricRouteTicketClaimsV1> {
    const confirmation = this.#options.confirmWithHub;
    if (confirmation === undefined) {
      throw new FabricContractError("unavailable", "This Edge has no Hub ticket confirmation port", "confirmWithHub");
    }
    assertValidFabricRouteTicket(ticket, this.#now());
    const claims = await confirmation.confirm(ticket, expectation);
    const config = this.#options.config;
    requireAllowedEdgeDevice(config, claims.deviceId);
    const endpoint = requireAllowedEdgeEndpoint(config, claims.deviceId, claims.endpointId);
    for (const operationClass of claims.operationClasses) {
      if (!endpoint.operationClasses.includes(operationClass)) {
        throw new FabricContractError("permission_denied", "Endpoint does not admit an operation class on this ticket", "operationClasses");
      }
    }
    if (claims.workspaceBindingId !== undefined) {
      requireAllowedEdgeWorkspace(config, claims.deviceId, claims.workspaceBindingId);
    }
    return claims;
  }

  /**
   * Advance one route to another pre-admitted path for the same Endpoint.
   *
   * The switch is revision-fenced, may only leave the path that failed, and may
   * never change route, Device, Endpoint, or any generation. There is no scan
   * and no re-selection: the alternatives are exactly the route's own
   * candidates that this Edge already admits.
   */
  async advancePath(input: FabricEdgePathAdvance): Promise<EndpointRouteHandle> {
    assertRevision(input.expectedRevision, "expectedRevision");
    if (!AUTOMATICALLY_ADVANCEABLE.includes(input.replayClass)) {
      throw new FabricContractError(
        "permission_denied",
        "A failed non-replayable operation is not replayed on another path",
        "replayClass",
      );
    }
    const current = this.#options.routes.validateRoute(input.routeId);
    if (current.revision !== input.expectedRevision) {
      throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
    }
    if (current.selectedPath !== input.failedPath) {
      throw new FabricContractError("conflict", "Only the path that failed may be left behind", "failedPath");
    }
    const target = (current.pathCandidates ?? []).find(
      (candidate) => candidate !== input.failedPath && this.#options.config.pathCandidates.includes(candidate),
    );
    if (target === undefined) {
      throw new FabricContractError(
        "unavailable",
        "No pre-admitted alternative path exists for this Endpoint",
        "pathCandidates",
      );
    }
    const next = await this.#options.admissions.switchRoutePath(input.routeId, input.expectedRevision, target);
    // Defence in depth: a switch that moved identity is not a path switch, and
    // publishing it would silently redirect work to another Endpoint.
    if (!sameRouteIdentity(current, next)) {
      throw new FabricContractError("protocol_violation", "A path switch changed route identity", "routeId");
    }
    if (next.selectedPath !== target || next.revision !== input.expectedRevision + 1) {
      throw new FabricContractError("protocol_violation", "A path switch did not commit the admitted candidate", "selectedPath");
    }
    return next;
  }

  #assertAllowedSubject(subject: FabricEdgeSubjectV1): void {
    const config = this.#options.config;
    switch (subject.kind) {
      case "connector":
        return;
      case "device": {
        const deviceId = subject.deviceId;
        if (deviceId === undefined) {
          throw new FabricContractError("invalid_argument", "A device subject must name a Device", "deviceId");
        }
        requireAllowedEdgeDevice(config, deviceId);
        return;
      }
      case "endpoint": {
        const deviceId = subject.deviceId;
        const endpointId = subject.endpointId;
        if (deviceId === undefined || endpointId === undefined) {
          throw new FabricContractError("invalid_argument", "An endpoint subject must name a Device and an Endpoint", "endpointId");
        }
        requireAllowedEdgeEndpoint(config, deviceId, endpointId);
        return;
      }
      case "workspace": {
        const deviceId = subject.deviceId;
        const workspaceBindingId = subject.workspaceBindingId;
        if (deviceId === undefined || workspaceBindingId === undefined) {
          throw new FabricContractError("invalid_argument", "A workspace subject must name a Device and a binding", "workspaceBindingId");
        }
        requireAllowedEdgeWorkspace(config, deviceId, workspaceBindingId);
        return;
      }
      default:
        throw new FabricContractError("invalid_argument", "Unsupported Edge subject kind", "kind");
    }
  }

  #inventoryPayload(): Readonly<Record<string, JsonValue>> {
    const config = this.#options.config;
    return {
      connectorId: config.connectorId,
      pathCandidates: [...config.pathCandidates],
      devices: config.devices.map((device) => ({
        deviceId: device.deviceId,
        endpoints: config.endpoints
          .filter((endpoint) => endpoint.deviceId === device.deviceId)
          .map((endpoint) => ({ endpointId: endpoint.endpointId, operationClasses: [...endpoint.operationClasses] })),
      })),
      // Device-local roots stay on the device; the advertisement names identity only.
      workspaces: config.workspaces.map((workspace) => ({
        workspaceBindingId: workspace.workspaceBindingId,
        deviceId: workspace.deviceId,
        workspaceId: workspace.workspaceId,
      })),
    };
  }
}
