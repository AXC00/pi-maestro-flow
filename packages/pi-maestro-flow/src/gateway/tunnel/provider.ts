/** Provider registry and local-control adapter. No MCP tools are registered here. */
import type { GatewayTunnelControlAction } from "../control-dispatcher.ts";
import type { GatewayTunnelOperationOptions, GatewayTunnelProvider, GatewayTunnelState } from "./contracts.ts";
import { GatewayTunnelProcessOwner } from "./process-owner.ts";
import { GatewayTunnelStateStore, gatewayTunnelStatePath, gatewayTunnelStateRoot } from "./state-store.ts";
import { GatewayTunnelSupervisor, type GatewayTunnelSupervisorOptions } from "./supervisor.ts";
import type { GatewayObservationSink } from "../observability.ts";

export type GatewayTunnelPublicState = Omit<GatewayTunnelState, "ownerToken">;

export interface GatewayTunnelProfileDefinition {
  id: string;
  provider: string;
  /** UI-safe mode label; never contains provider arguments or secrets. */
  mode?: string;
  lifecycle: "ephemeral" | "persistent";
  enabled: boolean;
  input: Readonly<Record<string, unknown>>;
}

export interface GatewayTunnelDoctorProfile {
  profile: string;
  provider: string;
  mode?: string;
  lifecycle: "ephemeral" | "persistent";
  enabled: boolean;
  phase: GatewayTunnelPublicState["observed"]["phase"];
  readiness: boolean;
  /** Doctor is deliberately state-only: it never invokes provider doctor(). */
  stateOnly: true;
}

export interface GatewayTunnelDoctorReport {
  ok: boolean;
  bounded: true;
  sideEffects: false;
  profiles: GatewayTunnelDoctorProfile[];
}

export interface GatewayTunnelManagerOptions {
  providers?: readonly GatewayTunnelProvider[];
  profiles?: readonly GatewayTunnelProfileDefinition[];
  stateRoot?: string;
  processOwner?: GatewayTunnelProcessOwner;
  supervisorOptions?: Omit<Partial<GatewayTunnelSupervisorOptions>, "provider" | "instance" | "stateStore" | "processOwner" | "observer">;
  observer?: GatewayObservationSink;
}

export class GatewayTunnelProviderRegistry {
  private readonly providers = new Map<string, GatewayTunnelProvider>();
  constructor(providers: readonly GatewayTunnelProvider[] = []) { for (const provider of providers) this.register(provider); }
  register(provider: GatewayTunnelProvider): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider.name)) throw new Error("Tunnel provider name must be a safe identifier");
    if (this.providers.has(provider.name)) throw new Error(`Tunnel provider is already registered: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }
  get(name: string): GatewayTunnelProvider | undefined { return this.providers.get(name); }
  list(): GatewayTunnelProvider[] { return [...this.providers.values()]; }
}

export class GatewayTunnelManager {
  readonly registry: GatewayTunnelProviderRegistry;
  readonly stateRoot: string;
  private readonly processOwner?: GatewayTunnelProcessOwner;
  private readonly supervisorOptions: GatewayTunnelManagerOptions["supervisorOptions"];
  private readonly observer?: GatewayObservationSink;
  private readonly supervisors = new Map<string, GatewayTunnelSupervisor>();
  private readonly supervisorInputs = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly profiles = new Map<string, GatewayTunnelProfileDefinition>();

  constructor(options: GatewayTunnelManagerOptions = {}) {
    this.registry = new GatewayTunnelProviderRegistry(options.providers);
    this.stateRoot = options.stateRoot ?? gatewayTunnelStateRoot();
    this.processOwner = options.processOwner;
    this.supervisorOptions = options.supervisorOptions;
    this.observer = options.observer;
    for (const profile of options.profiles ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.id)) throw new Error("Tunnel profile id must be a safe identifier");
      if (this.profiles.has(profile.id)) throw new Error(`Tunnel profile is already registered: ${profile.id}`);
      if (!this.registry.get(profile.provider)) throw new Error(`Unknown tunnel provider for profile ${profile.id}: ${profile.provider}`);
      this.profiles.set(profile.id, { ...profile, input: structuredClone(profile.input) });
    }
  }

  register(provider: GatewayTunnelProvider): void { this.registry.register(provider); }

  listProfiles(): GatewayTunnelProfileDefinition[] {
    return [...this.profiles.values()].map((profile) => ({ ...profile, input: structuredClone(profile.input) }));
  }

  /**
   * Local-only, bounded doctor for operator surfaces. It reads persisted
   * supervisor state and intentionally does not call provider.doctor(), which
   * may execute an external binary. No desired state, credentials, or process
   * lifecycle is changed by this operation.
   */
  async doctor(options: { maxProfiles?: number; deadlineAt?: number } = {}): Promise<GatewayTunnelDoctorReport> {
    const profiles = [...this.profiles.values()].slice(0, Math.min(32, Math.max(1, options.maxProfiles ?? 32)));
    const results: GatewayTunnelDoctorProfile[] = [];
    for (const profile of profiles) {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break;
      const state = await this.supervisor(profile.provider, profile.id).status();
      const phase = state?.observed.phase ?? "stopped";
      results.push({
        profile: profile.id,
        provider: profile.provider,
        ...(profile.mode === undefined ? {} : { mode: profile.mode }),
        lifecycle: profile.lifecycle,
        enabled: profile.enabled,
        phase,
        readiness: phase === "ready",
        stateOnly: true,
      });
    }
    return { ok: results.every((entry) => !entry.enabled || entry.readiness), bounded: true, sideEffects: false, profiles: results };
  }

  profile(id: string): GatewayTunnelProfileDefinition {
    const profile = this.profiles.get(id);
    if (!profile) throw controlError("tunnel_profile_unavailable", `Unknown tunnel profile: ${id}`);
    return profile;
  }

  /** Replace a persisted profile's derived provider input after listener bind. */
  updateProfileInput(id: string, input: Readonly<Record<string, unknown>>): void {
    const profile = this.profile(id);
    const updated = { ...profile, input: structuredClone(input) };
    this.profiles.set(id, updated);
    this.supervisorInputs.set(`${profile.provider}\0${profile.id}`, updated.input);
  }

  supervisor(providerName: string, instance = "default"): GatewayTunnelSupervisor {
    const provider = this.registry.get(providerName);
    if (!provider) throw controlError("tunnel_provider_unavailable", `Unknown tunnel provider: ${providerName}`);
    const path = gatewayTunnelStatePath(providerName, instance, this.stateRoot);
    const key = `${providerName}\0${instance}`;
    let supervisor = this.supervisors.get(key);
    if (!supervisor) {
      supervisor = new GatewayTunnelSupervisor({
        provider,
        instance,
        stateStore: new GatewayTunnelStateStore({ path, provider: providerName, instance }),
        ...(this.processOwner ? { processOwner: this.processOwner } : {}),
        ...(this.observer ? { observer: this.observer } : {}),
        ...this.supervisorOptions,
      });
      this.supervisors.set(key, supervisor);
    }
    return supervisor;
  }

  async control(action: GatewayTunnelControlAction, data?: Record<string, unknown>): Promise<unknown> {
    if (action === "tunnel-status" && data?.provider === undefined && data?.profile === undefined) {
      const states = await Promise.all(this.registry.list().map(async (provider) => {
        const state = await this.supervisor(provider.name).status();
        return state ? publicState(state) : { provider: provider.name, instance: "default", desiredState: "stopped", observed: { phase: "stopped" } };
      }));
      return { providers: states };
    }
    const profile = data?.profile === undefined ? undefined : this.profile(requiredIdentifier(data.profile, "profile"));
    const provider = profile?.provider ?? requiredIdentifier(data?.provider, "provider");
    const instance = profile?.id ?? (data?.instance === undefined ? "default" : requiredIdentifier(data.instance, "instance"));
    // A persisted profile is an authorization boundary. Generic provider
    // lifecycle commands (with or without input) cannot target that instance
    // and thereby bypass its canonical policy.
    if (profile === undefined) {
      const persisted = this.profiles.get(instance);
      if (persisted?.provider === provider) throw controlError("invalid_arguments", "Persisted tunnel profiles require profile-aware lifecycle commands");
    }
    const supervisor = this.supervisor(provider, instance);
    const key = `${provider}\0${instance}`;
    const options = operationOptions(data, profile?.input);
    if (options.input) this.supervisorInputs.set(key, options.input);
    const state = action === "tunnel-status" ? await supervisor.status()
      : action === "tunnel-start" ? await supervisor.start(options)
        : action === "tunnel-stop" ? await supervisor.stop(options)
          : await supervisor.restart(options);
    return state ? publicState(state) : { provider, instance, desiredState: "stopped", observed: { phase: "stopped" } };
  }

  async recoverAll(options: GatewayTunnelOperationOptions = {}): Promise<void> {
    const configuredDefaults = new Set([...this.profiles.values()].filter((profile) => profile.id === "default").map((profile) => profile.provider));
    const operations: Array<Promise<unknown>> = this.registry.list()
      .filter((provider) => !configuredDefaults.has(provider.name))
      .map((provider) => this.supervisor(provider.name).recover(options));
    for (const profile of this.profiles.values()) {
      const supervisor = this.supervisor(profile.provider, profile.id);
      const key = `${profile.provider}\0${profile.id}`;
      this.supervisorInputs.set(key, profile.input);
      operations.push((async () => {
        const current = await supervisor.status();
        if (profile.lifecycle === "ephemeral" || !profile.enabled) {
          if (current?.desiredState === "running") await supervisor.stop({ ...options, input: profile.input });
          return;
        }
        if (current?.desiredState === "running") {
          await supervisor.recover({ ...options, input: profile.input });
          return;
        }
        await supervisor.start({ ...options, input: profile.input });
      })());
    }
    await Promise.allSettled(operations);
  }

  async quiesceAll(deadlineAt: number): Promise<void> {
    await Promise.allSettled([...this.supervisors.entries()].map(([key, supervisor]) => supervisor.quiesce(deadlineAt, this.supervisorInputs.get(key))));
  }

  async closeAll(deadlineAt: number): Promise<void> {
    const persistent = new Set([...this.profiles.values()]
      .filter((profile) => profile.lifecycle === "persistent" && profile.enabled)
      .map((profile) => `${profile.provider}\0${profile.id}`));
    await Promise.allSettled([...this.supervisors.entries()].map(([key, supervisor]) => supervisor.close(
      deadlineAt,
      this.supervisorInputs.get(key),
      persistent.has(key),
    )));
  }
}

function operationOptions(data?: Record<string, unknown>, profileInput?: Readonly<Record<string, unknown>>): GatewayTunnelOperationOptions {
  const timeoutMs = optionalPositiveInteger(data?.timeoutMs, "timeoutMs");
  const deadlineAt = optionalPositiveInteger(data?.deadlineAt, "deadlineAt");
  const expectedGeneration = optionalNonNegativeInteger(data?.expectedGeneration ?? data?.generation, "expectedGeneration");
  const input = data?.input;
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw controlError("invalid_arguments", "Tunnel input must be an object");
  if (profileInput !== undefined && input !== undefined) throw controlError("invalid_arguments", "Tunnel profile input cannot be overridden");
  const effectiveInput = profileInput ?? input as Record<string, unknown> | undefined;
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    ...(effectiveInput === undefined ? {} : { input: effectiveInput }),
  };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw controlError("invalid_arguments", `Tunnel ${field} is required and must be a safe identifier`);
  return value;
}
function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw controlError("invalid_arguments", `Tunnel ${field} must be a positive integer`);
  return parsed;
}
function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw controlError("invalid_arguments", `Tunnel ${field} must be a non-negative integer`);
  return parsed;
}
function publicState(state: GatewayTunnelState): GatewayTunnelPublicState {
  const { ownerToken: _ownerToken, ...safe } = state;
  return safe;
}
function controlError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
