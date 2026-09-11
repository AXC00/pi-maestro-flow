import { FabricContractError } from "pi-maestro-fabric-core/v1";

export interface McpContinuationLease {
  readonly identity: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}

/** Generation-owned authority used to fence callbacks and other async continuations. */
export class McpContinuationAuthority {
  #generation = 1;
  #controller = new AbortController();

  constructor(readonly identity: string) {}

  capture(): McpContinuationLease {
    const generation = this.#generation;
    const controller = this.#controller;
    return {
      identity: this.identity,
      generation,
      signal: controller.signal,
      isCurrent: () => generation === this.#generation && !controller.signal.aborted,
      assertCurrent: () => {
        if (generation !== this.#generation || controller.signal.aborted) {
          throw new FabricContractError(
            "stale_generation",
            `${this.identity} continuation is no longer authoritative`,
          );
        }
      },
    };
  }

  renew(reason = `${this.identity} authority replaced`): McpContinuationLease {
    this.revoke(reason);
    this.#controller = new AbortController();
    return this.capture();
  }

  revoke(reason = `${this.identity} authority revoked`): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new FabricContractError("cancelled", reason));
    }
    this.#generation += 1;
  }
}

export interface FabricMcpRouteLease extends McpContinuationLease {
  readonly mountId: string;
  readonly serverName: string;
  readonly routeRevision: number;
  readonly mutation: boolean;
  validateCurrent(): Promise<void>;
}

export interface FabricMcpRouteGuardOptions {
  readonly mountId: string;
  readonly serverName: string;
  readonly routeRevision: number;
  readonly mutation: boolean;
  readonly validate: () => Promise<void>;
  readonly onInvalid?: (error: unknown) => void;
}

/** Local-first guard for one exact Fabric mount identity and its outer route authority. */
export class FabricMcpRouteGuard {
  readonly #authority: McpContinuationAuthority;
  readonly #validate: () => Promise<void>;

  constructor(readonly options: FabricMcpRouteGuardOptions) {
    this.#authority = new McpContinuationAuthority(
      `Fabric MCP route ${options.serverName} (${options.mountId}@${options.routeRevision})`,
    );
    this.#validate = options.validate;
  }

  capture(): FabricMcpRouteLease {
    const local = this.#authority.capture();
    const options = this.options;
    return {
      ...local,
      mountId: options.mountId,
      serverName: options.serverName,
      routeRevision: options.routeRevision,
      mutation: options.mutation,
      validateCurrent: async () => {
        local.assertCurrent();
        try {
          await this.#validate();
          local.assertCurrent();
        } catch (error) {
          this.revoke(`Fabric MCP route ${options.mountId} validation failed`);
          options.onInvalid?.(error);
          throw error;
        }
      },
    };
  }

  isCurrent(): boolean {
    return this.#authority.capture().isCurrent();
  }

  revoke(reason?: string): void {
    this.#authority.revoke(reason);
  }
}

/** A dispatched Fabric mutation whose reply was lost must never be silently replayed. */
export class FabricMcpOutcomeUnknownError extends FabricContractError {
  readonly retryable = false;

  constructor() {
    super(
      "outcome_unknown",
      "Fabric MCP mutation may have reached the Endpoint; its outcome is unknown and it was not replayed",
      "operation",
    );
    this.name = "FabricMcpOutcomeUnknownError";
  }
}

export function combineMcpSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}
