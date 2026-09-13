import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayControlClient } from "../control-client.ts";
import {
  FABRIC_CONNECTOR_CONFIG_FILE,
  loadFabricConnectorConfig,
  type FabricConnectorConfigV1,
} from "./connector-config.ts";
import type { FabricConnectorServiceStatus } from "./connector-service.ts";
import { requireIdentityMetadata } from "./connector-registration-cli.ts";

export interface FabricConnectorDaemonControl {
  fabricConnectorStatus(): Promise<FabricConnectorServiceStatus | { configured: false; state: "stopped" | "failed"; running: false; reason?: string }>;
  fabricConnectorStart(): Promise<FabricConnectorServiceStatus>;
  fabricConnectorStop(): Promise<FabricConnectorServiceStatus>;
}

export interface FabricConnectorCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Workspace root whose `.pi/` holds the Connector configuration. */
  readonly root: string;
  readonly json: boolean;
  readonly control?: FabricConnectorDaemonControl;
}

export function fabricConnectorConfigPath(root: string): string {
  return join(root, ".pi", FABRIC_CONNECTOR_CONFIG_FILE);
}

/** Legacy foreground marker retained only for migration detection. */
export function fabricConnectorPidPath(root: string): string {
  return join(root, ".pi", "fabric-connector.pid");
}

const LEGACY_DIAGNOSTIC = "A legacy foreground Connector PID marker exists. Stop that foreground process manually, remove .pi/fabric-connector.pid, then use the Gateway daemon-owned Connector controls.";

/** Status is read through authenticated daemon IPC when the daemon is online. */
export async function fabricConnectorStatus(io: FabricConnectorCliIo): Promise<number> {
  const config = await loadFabricConnectorConfig(fabricConnectorConfigPath(io.root));
  const legacyPid = await readLegacyPid(io.root);
  if (legacyPid !== undefined) {
    return report(io, {
      configured: config !== undefined,
      enabled: config?.enabled,
      running: false,
      legacyForeground: true,
      legacyPid,
      migrationDiagnostic: LEGACY_DIAGNOSTIC,
      ...(config === undefined ? {} : publicConfig(config)),
    }, LEGACY_DIAGNOSTIC);
  }

  try {
    const status = await controlOf(io).fabricConnectorStatus();
    return report(io, status as unknown as Record<string, unknown>, connectorStatusText(status));
  } catch {
    // Preserve the useful read-only configuration view while making no attempt
    // to create or own a Connector outside the Gateway daemon.
    if (config === undefined) {
      return report(io, { configured: false, running: false }, "Fabric Connector is not configured for this workspace");
    }
    const keyPresent = await fileExists(config.privateKeyPath);
    const caPresent = config.caPath === undefined ? undefined : await fileExists(config.caPath);
    return report(io, {
      configured: true,
      enabled: config.enabled,
      running: false,
      ...publicConfig(config),
      keyPresent,
      ...(caPresent === undefined ? {} : { caPresent }),
    }, config.enabled
      ? `Fabric Connector ${config.connectorId} -> ${config.hubUrl} (Gateway daemon offline)`
      : `Fabric Connector ${config.connectorId} is configured but disabled`);
  }
}

/** Start one generation in the already-running Gateway daemon. */
export async function fabricConnectorStart(io: FabricConnectorCliIo): Promise<number> {
  const config = await loadFabricConnectorConfig(fabricConnectorConfigPath(io.root));
  if (config === undefined) {
    io.stderr("Fabric Connector is not configured; enroll it first\n");
    return 1;
  }
  if (!config.enabled) {
    io.stderr(`Fabric Connector ${config.connectorId} is disabled in its configuration\n`);
    return 1;
  }
  try { requireIdentityMetadata(config); }
  catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (await rejectLegacy(io)) return 1;
  try {
    const status = await controlOf(io).fabricConnectorStart();
    report(io, status as unknown as Record<string, unknown>, connectorStatusText(status));
    return 0;
  } catch (error) {
    io.stderr(`${safeControlError(error)}\n`);
    return 1;
  }
}

/** Stop only the daemon-owned runtime. A legacy PID is never signalled. */
export async function fabricConnectorStop(io: FabricConnectorCliIo): Promise<number> {
  if (await rejectLegacy(io)) return 1;
  try {
    const status = await controlOf(io).fabricConnectorStop();
    report(io, status as unknown as Record<string, unknown>, connectorStatusText(status));
    return 0;
  } catch (error) {
    io.stderr(`${safeControlError(error)}\n`);
    return 1;
  }
}

function controlOf(io: FabricConnectorCliIo): FabricConnectorDaemonControl {
  return io.control ?? new GatewayControlClient({ cwd: io.root });
}

async function rejectLegacy(io: FabricConnectorCliIo): Promise<boolean> {
  const pid = await readLegacyPid(io.root);
  if (pid === undefined) return false;
  io.stderr(`${LEGACY_DIAGNOSTIC} Detected marker pid ${pid}; it was not signalled.\n`);
  return true;
}

async function readLegacyPid(root: string): Promise<number | undefined> {
  try {
    const text = (await readFile(fabricConnectorPidPath(root), "utf8")).trim();
    if (!/^\d+$/u.test(text)) return undefined;
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch { return false; }
}

function publicConfig(config: FabricConnectorConfigV1): Record<string, unknown> {
  return {
    hubUrl: config.hubUrl,
    connectorId: config.connectorId,
    keyId: config.keyId,
    audience: config.audience,
    credentialGeneration: config.credentialGeneration,
  };
}

function connectorStatusText(status: { configured: boolean; state: string; connectorId?: string; hubUrl?: string; reason?: string }): string {
  if (!status.configured) return status.reason ?? "Fabric Connector is not configured in the Gateway daemon";
  const identity = status.connectorId === undefined ? "Fabric Connector" : `Fabric Connector ${status.connectorId}`;
  const target = status.hubUrl === undefined ? "" : ` -> ${status.hubUrl}`;
  const reason = status.reason === undefined ? "" : `: ${status.reason}`;
  return `${identity}${target} (${status.state})${reason}`;
}

function safeControlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Gateway is offline|Gateway daemon is offline|Pi Maestro Gateway is offline/u.test(message)) {
    return "Pi Maestro Gateway is offline. Start it with `pi-maestro-gateway serve`, then retry the Connector command.";
  }
  // Daemon control errors are deliberately from a bounded, redacted set.
  return message.length <= 512 ? message : "Fabric Connector control failed";
}

function report(io: FabricConnectorCliIo, value: Record<string, unknown>, text: string): number {
  io.stdout(io.json ? `${JSON.stringify(value)}\n` : `${text}\n`);
  return 0;
}
