import { createPrivateKey, sign as signPayload } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FABRIC_CONNECTOR_CONFIG_FILE,
  loadFabricConnectorConfig,
  type FabricConnectorConfigV1,
} from "./connector-config.ts";
import { FabricConnectorRuntime } from "./connector-runtime.ts";

export interface FabricConnectorCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Workspace root whose `.pi/` holds the Connector configuration. */
  readonly root: string;
  readonly json: boolean;
  /** Foreground seam: production waits for a signal, tests resolve directly. */
  readonly waitForStop?: (stop: () => Promise<void>) => Promise<void>;
}

export function fabricConnectorConfigPath(root: string): string {
  return join(root, ".pi", FABRIC_CONNECTOR_CONFIG_FILE);
}

export function fabricConnectorPidPath(root: string): string {
  return join(root, ".pi", "fabric-connector.pid");
}

/**
 * `connector status` — report what this device is configured to do.
 *
 * Read-only: it never dials the Hub, so asking for status cannot itself become
 * the connection an operator is trying to diagnose.
 */
export async function fabricConnectorStatus(io: FabricConnectorCliIo): Promise<number> {
  const config = await loadFabricConnectorConfig(fabricConnectorConfigPath(io.root));
  const pid = await readPid(io.root);
  if (config === undefined) {
    return report(io, { configured: false, running: pid !== undefined, ...(pid === undefined ? {} : { pid }) },
      "Fabric Connector is not configured for this workspace");
  }
  const keyPresent = await fileExists(config.privateKeyPath);
  const caPresent = config.caPath === undefined ? undefined : await fileExists(config.caPath);
  return report(io, {
    configured: true,
    enabled: config.enabled,
    running: pid !== undefined,
    ...(pid === undefined ? {} : { pid }),
    hubUrl: config.hubUrl,
    connectorId: config.connectorId,
    keyId: config.keyId,
    audience: config.audience,
    credentialGeneration: config.credentialGeneration,
    keyPresent,
    ...(caPresent === undefined ? {} : { caPresent }),
  }, config.enabled
    ? `Fabric Connector ${config.connectorId} -> ${config.hubUrl}${pid === undefined ? " (stopped)" : ` (pid ${pid})`}`
    : `Fabric Connector ${config.connectorId} is configured but disabled`);
}

/**
 * `connector start` — dial the Hub in the foreground until interrupted.
 *
 * The private key is read here and never leaves this process: the runtime is
 * handed a signing closure, not key material.
 */
export async function fabricConnectorStart(io: FabricConnectorCliIo): Promise<number> {
  const config = await loadFabricConnectorConfig(fabricConnectorConfigPath(io.root));
  if (config === undefined) {
    io.stderr("Fabric Connector is not configured; write .pi/fabric-connector.json first\n");
    return 1;
  }
  if (!config.enabled) {
    io.stderr(`Fabric Connector ${config.connectorId} is disabled in its configuration\n`);
    return 1;
  }
  const running = await readPid(io.root);
  if (running !== undefined) {
    io.stderr(`Fabric Connector is already running (pid ${running})\n`);
    return 1;
  }

  let runtime: FabricConnectorRuntime;
  try {
    const privateKey = await readPrivateKey(config);
    const ca = config.caPath === undefined ? undefined : await readFile(config.caPath);
    runtime = new FabricConnectorRuntime({
      url: config.hubUrl,
      connectorId: config.connectorId,
      keyId: config.keyId,
      audience: config.audience,
      credentialGeneration: config.credentialGeneration,
      ...(ca === undefined ? {} : { ca }),
      ...(config.heartbeatIntervalMs === undefined ? {} : { limits: { heartbeatIntervalMs: config.heartbeatIntervalMs } }),
      ...(config.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: config.reconnectDelayMs }),
      ...(config.maxReconnectAttempts === undefined ? {} : { maxReconnectAttempts: config.maxReconnectAttempts }),
      sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
      onError: (message) => io.stderr(`fabric connector: ${message}\n`),
      onReady: (info) => io.stdout(io.json
        ? `${JSON.stringify(info)}\n`
        : `Fabric Connector ready (generation ${info.connectionGeneration})\n`),
    });
  } catch (error) {
    io.stderr(`Fabric Connector could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  await mkdir(dirname(fabricConnectorPidPath(io.root)), { recursive: true });
  await writeFile(fabricConnectorPidPath(io.root), String(process.pid), "utf8");
  const stop = async (): Promise<void> => {
    await runtime.stop("the Connector CLI stopped").catch(() => undefined);
    await rm(fabricConnectorPidPath(io.root), { force: true });
  };
  try {
    await runtime.start();
    if (io.waitForStop === undefined) await waitForSignal(stop);
    else await io.waitForStop(stop);
    return 0;
  } catch (error) {
    await stop();
    io.stderr(`Fabric Connector stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * `connector stop` — ask the running Connector to stop.
 *
 * The pid file is the only handle this process has on a Connector started
 * elsewhere, and a stale file is cleaned up rather than reported as running.
 */
export async function fabricConnectorStop(io: FabricConnectorCliIo): Promise<number> {
  const pid = await readPid(io.root);
  if (pid === undefined) {
    io.stderr("No Fabric Connector is running for this workspace\n");
    return 1;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await rm(fabricConnectorPidPath(io.root), { force: true });
    io.stderr(`Fabric Connector pid ${pid} is no longer running; removed its stale pid file\n`);
    return 1;
  }
  // Bounded wait: a Connector that ignores the signal is reported, not awaited
  // indefinitely.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await readPid(io.root) === undefined) {
      io.stdout(io.json ? `${JSON.stringify({ stopped: true, pid })}\n` : `Fabric Connector ${pid} stopped\n`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  io.stderr(`Fabric Connector ${pid} did not stop within 5s\n`);
  return 1;
}

async function readPrivateKey(config: FabricConnectorConfigV1): Promise<ReturnType<typeof createPrivateKey>> {
  let pem: Buffer;
  try {
    pem = await readFile(config.privateKeyPath);
  } catch {
    throw new Error(`the Connector private key at ${config.privateKeyPath} could not be read`);
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the Connector private key at ${config.privateKeyPath} is not an Ed25519 key`);
  }
  return key;
}

async function readPid(root: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(fabricConnectorPidPath(root), "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function report(io: FabricConnectorCliIo, value: Record<string, unknown>, text: string): number {
  io.stdout(io.json ? `${JSON.stringify(value)}\n` : `${text}\n`);
  return 0;
}

function waitForSignal(stop: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      void stop().then(() => resolve());
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}
