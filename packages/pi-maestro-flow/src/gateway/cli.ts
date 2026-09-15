/** Command line entry for the packaged Gateway daemon and stdio relay. */
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { assertBoundedString, assertFabricIdentifier } from "pi-maestro-fabric-core/v1";
import { GatewayDaemon } from "./daemon.ts";
import { connectGatewayIpc, requestGatewayIpcControl } from "./ipc.ts";
import { GatewayOwnerActiveError, GatewayOwnerStore } from "./owner-store.ts";
import type { GatewayOwnerRecord } from "./contracts.ts";
import { GATEWAY_OFFLINE_MESSAGE, relayGatewayStdio } from "./stdio-relay.ts";
import { GatewayResidentService } from "./resident-service.ts";
import { loadGatewayConfig, writeGatewayConfigPatch } from "./config.ts";
import { applyPiConfigStream, serializePiConfigApplyError } from "./pi-config-apply.ts";
import { GatewayControlClient } from "./control-client.ts";
import { migrateLegacyGateway } from "./config-migration.ts";
import { serializeGatewayLegacyMigrationError } from "./migration-contracts.ts";
import { gatewayConfigPath } from "./state-paths.ts";
import { enforceGatewayPrivatePath, type GatewayWindowsAclRunner } from "./private-path.ts";
import type { FabricConnectorRegistrationHttp } from "./fabric/connector-registration-cli.ts";

export interface GatewayCliIo {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  /** Test seam for lifecycle sequencing; production always constructs the native client. */
  createControlClient?: (configPath?: string) => GatewayControlClient;
  /** Test seams for Connector registration; production uses cwd, native HTTPS, and the host platform. */
  connectorRoot?: string;
  fabricRegistrationHttp?: FabricConnectorRegistrationHttp;
  connectorPlatform?: NodeJS.Platform;
  connectorWindowsAclRunner?: GatewayWindowsAclRunner;
}

interface ServeFlags {
  configPath?: string;
  host?: string;
  port?: number;
  http?: boolean;
  json: boolean;
}

interface ServiceFlags {
  configPath?: string;
  json: boolean;
  detachedFallback: boolean;
  windowsStartup: boolean;
}

interface WorkspaceFlags {
  configPath?: string;
  json: boolean;
  target?: string;
  ttlSeconds?: number;
  expectedGeneration?: number;
  permanent: boolean;
}

interface TunnelFlags {
  configPath?: string;
  json: boolean;
  provider?: string;
  instance?: string;
  timeoutMs?: number;
  expectedGeneration?: number;
  localPort?: number;
  binaryPath?: string;
  experimental: boolean;
  tunnelIdEnv?: string;
  runtimeKeyEnv?: string;
}

function write(stream: Writable, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function parseServeFlags(args: string[]): ServeFlags {
  const result: ServeFlags = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--no-http") result.http = false;
    else if (arg === "--http") result.http = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else if (arg === "--host") result.host = requiredValue(args, ++index, arg);
    else if (arg === "--port") {
      const value = Number(requiredValue(args, ++index, arg));
      if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer in [0, 65535]");
      result.port = value;
    } else throw new Error(`Unknown serve option: ${arg}`);
  }
  return result;
}

function parseServiceFlags(args: string[]): ServiceFlags {
  const result: ServiceFlags = { json: false, detachedFallback: false, windowsStartup: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--detached-fallback") result.detachedFallback = true;
    else if (arg === "--windows-startup") result.windowsStartup = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else throw new Error(`Unknown service option: ${arg}`);
  }
  if (result.detachedFallback && result.windowsStartup) throw new Error("--windows-startup and --detached-fallback are mutually exclusive");
  if (result.windowsStartup && process.platform !== "win32") throw new Error("--windows-startup is only available on Windows");
  return result;
}

function parseWorkspaceFlags(args: string[]): WorkspaceFlags {
  const result: WorkspaceFlags = { json: false, permanent: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--permanent") result.permanent = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else if (arg === "--ttl") result.ttlSeconds = positiveCliInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--generation") result.expectedGeneration = positiveCliInteger(requiredValue(args, ++index, arg), arg);
    else if (arg.startsWith("--")) throw new Error(`Unknown workspace option: ${arg}`);
    else if (result.target === undefined) result.target = arg;
    else throw new Error(`Unexpected workspace argument: ${arg}`);
  }
  if (result.permanent && result.ttlSeconds !== undefined) throw new Error("--permanent and --ttl are mutually exclusive");
  return result;
}

function parseTunnelFlags(args: string[]): TunnelFlags {
  const result: TunnelFlags = { json: false, experimental: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else if (arg === "--timeout-ms") result.timeoutMs = positiveCliInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--generation") result.expectedGeneration = positiveCliInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--local-port") {
      result.localPort = positiveCliInteger(requiredValue(args, ++index, arg), arg);
      if (result.localPort > 65_535) throw new Error("--local-port must be in [1, 65535]");
    }
    else if (arg === "--binary") result.binaryPath = requiredValue(args, ++index, arg);
    else if (arg === "--experimental") result.experimental = true;
    else if (arg === "--tunnel-id-env") result.tunnelIdEnv = requiredValue(args, ++index, arg);
    else if (arg === "--runtime-key-env") result.runtimeKeyEnv = requiredValue(args, ++index, arg);
    else if (arg.startsWith("--")) throw new Error(`Unknown tunnel option: ${arg}`);
    else if (result.provider === undefined) result.provider = arg;
    else if (result.instance === undefined) result.instance = arg;
    else throw new Error(`Unexpected tunnel argument: ${arg}`);
  }
  return result;
}

function positiveCliInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requiredDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

interface FabricEnrollmentDeviceInput {
  readonly deviceId: string;
  readonly label: string;
  readonly connectionMode: "https";
  readonly platform?: string;
  readonly architecture?: string;
  readonly enabled: boolean;
}

const MAX_FABRIC_INVENTORY_BYTES = 64 * 1024;
const FABRIC_INVENTORY_DEVICE_KEYS = new Set([
  "deviceId", "label", "connectionMode", "platform", "architecture", "enabled",
]);

async function readFabricEnrollmentInventory(pathInput: string): Promise<FabricEnrollmentDeviceInput[]> {
  const raw = await readFile(resolve(pathInput), "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_FABRIC_INVENTORY_BYTES) {
    throw new Error("--inventory-file exceeds 64 KiB");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 256) {
    throw new Error("--inventory-file must contain 1 to 256 Devices");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`--inventory-file Device ${index} must be an object`);
    }
    const source = entry as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(source)) {
      if (!FABRIC_INVENTORY_DEVICE_KEYS.has(key)) {
        throw new Error(`--inventory-file Device ${index} has unsupported field ${JSON.stringify(key)}`);
      }
    }
    assertFabricIdentifier(source.deviceId, `devices[${index}].deviceId`);
    assertBoundedString(source.label, `devices[${index}].label`, 256);
    if (source.connectionMode !== "https" || typeof source.enabled !== "boolean") {
      throw new Error(`--inventory-file Device ${index} must use connectionMode https and declare enabled`);
    }
    if (source.platform !== undefined) assertBoundedString(source.platform, `devices[${index}].platform`, 256);
    if (source.architecture !== undefined) assertBoundedString(source.architecture, `devices[${index}].architecture`, 256);
    return {
      deviceId: source.deviceId,
      label: source.label,
      connectionMode: "https",
      ...(source.platform === undefined ? {} : { platform: source.platform }),
      ...(source.architecture === undefined ? {} : { architecture: source.architecture }),
      enabled: source.enabled,
    };
  });
}

async function readPrivateTokenInput(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 2_048) throw new Error("Fabric purpose token input exceeds 2048 bytes");
    chunks.push(buffer);
  }
  const secret = Buffer.concat(chunks);
  try {
    const token = secret.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(token)) throw new Error("Fabric purpose token input is invalid");
    return token;
  } finally {
    secret.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function writePrivateToken(
  pathInput: string,
  token: string,
  options: { platform?: NodeJS.Platform; windowsAclRunner?: GatewayWindowsAclRunner } = {},
): Promise<string> {
  const path = resolve(pathInput);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceGatewayPrivatePath(directory, "directory", options);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await enforceGatewayPrivatePath(path, "file", options);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return path;
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch { /* packaging errors are reported with a stable protocol version */ }
  return "0.0.0";
}

export async function main(argv = process.argv.slice(2), io: GatewayCliIo = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const createControlClient = (configPath?: string): GatewayControlClient => io.createControlClient?.(configPath) ?? new GatewayControlClient({ configPath });
  const [command = "help", ...args] = argv;
  try {
    if (command === "version" || command === "--version" || command === "-v") {
      const version = await packageVersion();
      if (args.includes("--json")) write(stdout, JSON.stringify({ name: "pi-maestro-gateway", version, protocolVersion: 1 }));
      else write(stdout, `pi-maestro-gateway ${version}`);
      return 0;
    }
    if (command === "connect") {
      if (args.length !== 1 || args[0] !== "--stdio") throw new Error("Usage: pi-maestro-gateway connect --stdio");
      await relayGatewayStdio();
      return 0;
    }
    if (command === "connector") {
      const action = args[0];
      if (action === "enroll" || action === "rotate") {
        let hub: string | undefined;
        let connectorId: string | undefined;
        let deviceId: string | undefined;
        let inventoryFile: string | undefined;
        let localDeviceId: string | undefined;
        let caPath: string | undefined;
        let expectedRevision: number | undefined;
        let expectedGeneration: number | undefined;
        let tokenStdin = false;
        let json = false;
        for (let index = 1; index < args.length; index += 1) {
          const arg = args[index]!;
          if (arg === "--json") json = true;
          else if (arg === "--token-stdin") tokenStdin = true;
          else if (arg === "--hub") hub = requiredValue(args, ++index, arg);
          else if (arg === "--connector-id") connectorId = requiredValue(args, ++index, arg);
          else if (arg === "--device-id") deviceId = requiredValue(args, ++index, arg);
          else if (arg === "--inventory-file") inventoryFile = requiredValue(args, ++index, arg);
          else if (arg === "--local-device-id") localDeviceId = requiredValue(args, ++index, arg);
          else if (arg === "--ca") caPath = requiredValue(args, ++index, arg);
          else if (arg === "--expected-revision") expectedRevision = positiveCliInteger(requiredValue(args, ++index, arg), arg);
          else if (arg === "--expected-generation") expectedGeneration = positiveCliInteger(requiredValue(args, ++index, arg), arg);
          else throw new Error(`connector ${action} received an unsupported option; purpose tokens are never accepted in argv`);
        }
        if (!tokenStdin) throw new Error(`connector ${action} requires --token-stdin; tokens are never accepted in argv`);
        if (action === "enroll") {
          if (hub === undefined || connectorId === undefined) throw new Error("connector enroll requires --hub and --connector-id");
          if ((deviceId === undefined) === (inventoryFile === undefined)) throw new Error("connector enroll requires exactly one of --device-id or --inventory-file");
          if (inventoryFile !== undefined && localDeviceId === undefined) throw new Error("connector enroll with --inventory-file requires --local-device-id");
        } else {
          if (expectedRevision === undefined || expectedGeneration === undefined) throw new Error("connector rotate requires --expected-revision and --expected-generation");
          if (hub !== undefined || connectorId !== undefined || deviceId !== undefined || inventoryFile !== undefined || localDeviceId !== undefined) throw new Error("connector rotate reads identity and Hub from the active config");
        }
        const token = await readPrivateTokenInput(stdin);
        const { fabricConnectorEnroll, fabricConnectorRotate } = await import("./fabric/connector-registration-cli.ts");
        const root = io.connectorRoot ?? process.cwd();
        const config = action === "enroll" ? await (async () => {
          let devices: Array<{ deviceId: string; label: string; connectionMode: "https"; platform?: string; architecture?: string; enabled: boolean }>;
          if (deviceId !== undefined) {
            devices = [{ deviceId, label: deviceId, connectionMode: "https", platform: process.platform, architecture: process.arch, enabled: true }];
            localDeviceId = localDeviceId ?? deviceId;
          } else {
            devices = await readFabricEnrollmentInventory(
              requiredDefined(inventoryFile, "connector enroll requires --inventory-file"),
            );
          }
          return fabricConnectorEnroll({
            root, token,
            hub: requiredDefined(hub, "connector enroll requires --hub"),
            connectorId: requiredDefined(connectorId, "connector enroll requires --connector-id"),
            devices,
            localDeviceId: requiredDefined(localDeviceId, "connector enroll requires --local-device-id"),
            ...(caPath === undefined ? {} : { caPath }),
            ...(io.fabricRegistrationHttp === undefined ? {} : { http: io.fabricRegistrationHttp }),
            ...(io.connectorPlatform === undefined ? {} : { platform: io.connectorPlatform }),
            ...(io.connectorWindowsAclRunner === undefined ? {} : { windowsAclRunner: io.connectorWindowsAclRunner }),
          });
        })() : await (async () => {
          return fabricConnectorRotate({
            root, token,
            expectedRevision: requiredDefined(expectedRevision, "connector rotate requires --expected-revision"),
            expectedCredentialGeneration: requiredDefined(expectedGeneration, "connector rotate requires --expected-generation"),
            ...(caPath === undefined ? {} : { caPath }),
            ...(io.fabricRegistrationHttp === undefined ? {} : { http: io.fabricRegistrationHttp }),
            ...(io.connectorPlatform === undefined ? {} : { platform: io.connectorPlatform }),
            ...(io.connectorWindowsAclRunner === undefined ? {} : { windowsAclRunner: io.connectorWindowsAclRunner }),
          });
        })();
        const safe = { status: "active", connectorId: config.connectorId, keyId: config.keyId, credentialGeneration: config.credentialGeneration, revision: config.revision, configPath: resolve(root, ".pi", "fabric-connector.json") };
        write(stdout, json ? JSON.stringify(safe) : JSON.stringify(safe, null, 2));
        return 0;
      }
      if (action === "revoke") {
        const connectorId = requiredValue(args, 1, "connector revoke");
        let configPath: string | undefined;
        let requestId: string | undefined;
        let expectedRevision: number | undefined;
        let json = false;
        for (let index = 2; index < args.length; index += 1) {
          const arg = args[index]!;
          if (arg === "--json") json = true;
          else if (arg === "--config") configPath = requiredValue(args, ++index, arg);
          else if (arg === "--request-id") requestId = requiredValue(args, ++index, arg);
          else if (arg === "--expected-revision") expectedRevision = positiveCliInteger(requiredValue(args, ++index, arg), arg);
          else throw new Error(`Unknown connector revoke option: ${arg}`);
        }
        if (requestId === undefined) throw new Error("connector revoke requires --request-id");
        if (expectedRevision === undefined) throw new Error("connector revoke requires --expected-revision");
        const receipt = await createControlClient(configPath).revokeFabricConnector({ connectorId, requestId, expectedRevision });
        write(stdout, json ? JSON.stringify(receipt) : JSON.stringify(receipt, null, 2));
        return 0;
      }
      if (action !== "start" && action !== "stop" && action !== "status") {
        throw new Error("Usage: pi-maestro-gateway connector start|stop|status [--json] | connector enroll|rotate|revoke ...");
      }
      const flags = args.slice(1);
      const unknown = flags.filter((arg) => arg !== "--json");
      if (unknown.length > 0) throw new Error(`connector ${action} does not accept ${unknown[0]}`);
      const { fabricConnectorStart, fabricConnectorStatus, fabricConnectorStop } = await import("./fabric/connector-cli.ts");
      const connectorIo = {
        stdout: (text: string) => write(stdout, text.trimEnd()),
        stderr: (text: string) => write(stderr, text.trimEnd()),
        root: io.connectorRoot ?? process.cwd(),
        json: flags.includes("--json"),
        control: io.createControlClient?.() ?? new GatewayControlClient({ cwd: io.connectorRoot ?? process.cwd() }),
      };
      if (action === "status") return await fabricConnectorStatus(connectorIo);
      if (action === "start") return await fabricConnectorStart(connectorIo);
      return await fabricConnectorStop(connectorIo);
    }
    if (command === "config") {
      const { runGatewayConfigCommand } = await import("./config-tui.ts");
      await runGatewayConfigCommand(args, { input: stdin, output: stdout });
      return 0;
    }
    if (command === "config-sync") {
      if (args.length !== 1 || args[0] !== "apply") throw new Error("Usage: pi-maestro-gateway config-sync apply");
      write(stdout, JSON.stringify(await applyPiConfigStream(stdin)));
      return 0;
    }
    if (command === "migrate-legacy") {
      const dryRun = args.includes("--dry-run");
      const apply = args.includes("--apply");
      const json = args.includes("--json");
      if (args.some((arg) => !["--dry-run", "--apply", "--json"].includes(arg)) || dryRun === apply) throw new Error("Usage: pi-maestro-gateway migrate-legacy --dry-run|--apply [--json]");
      const value = await migrateLegacyGateway(dryRun ? "dry-run" : "apply");
      write(stdout, json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
      return 0;
    }
    if (command === "service-run") {
      const tokenIndex = args.indexOf("--installation-token");
      if (tokenIndex < 0) throw new Error("service-run requires --installation-token");
      const installationToken = requiredValue(args, tokenIndex + 1, "--installation-token");
      const configIndex = args.indexOf("--config");
      const configPath = configIndex < 0 ? undefined : requiredValue(args, configIndex + 1, "--config");
      const serviceConfig = await loadGatewayConfig(configPath);
      const resident = new GatewayResidentService({
        configPath,
        manifestPath: serviceConfig.state.serviceManifestPath,
        ownerPath: serviceConfig.state.ownerPath,
        allowDetachedFallback: args.includes("--detached-fallback") || (process.platform !== "win32" && process.platform !== "linux"),
      });
      await resident.validateServiceRun(installationToken, process.execPath, process.argv.slice(1), process.cwd());
      const daemon = new GatewayDaemon({ configPath, commandIdentity: process.argv.join(" ") });
      await daemon.start();
      await waitForShutdown(async () => daemon.stop(), daemon.waitUntilStopped());
      return 0;
    }
    if (command === "service") {
      const action = args[0];
      if (!action || !["install", "ensure", "start", "stop", "restart", "status", "uninstall"].includes(action)) throw new Error("Usage: pi-maestro-gateway service install|ensure|start|stop|restart|status|uninstall [--json]");
      const flags = parseServiceFlags(args.slice(1));
      const executableArg = process.argv[1];
      const serviceConfig = await loadGatewayConfig(flags.configPath);
      const resident = new GatewayResidentService({
        configPath: flags.configPath,
        manifestPath: serviceConfig.state.serviceManifestPath,
        ownerPath: serviceConfig.state.ownerPath,
        command: process.execPath,
        argsPrefix: executableArg ? [executableArg] : [],
        allowDetachedFallback: flags.detachedFallback,
        ...(flags.windowsStartup ? { preferredKind: "windows-startup" as const } : {}),
      });
      const value = action === "install" ? await (() => resident.install().then((manifest) => ({
        installed: true,
        kind: manifest.kind,
        installationId: manifest.installationId,
        installedAt: manifest.installedAt,
      })))()
        : action === "ensure" ? await resident.ensure()
          : action === "start" ? await resident.start()
            : action === "stop" ? await resident.stop()
              : action === "restart" ? await resident.restart()
                : action === "status" ? await resident.status()
                  : await resident.uninstall();
      write(stdout, flags.json ? JSON.stringify(value) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
      return 0;
    }
    if (command === "tunnel") {
      const action = args[0];
      if (action === "doctor") {
        const flags = parseTunnelFlags(args.slice(1));
        if (flags.provider !== undefined || flags.instance !== undefined || flags.expectedGeneration !== undefined
          || flags.localPort !== undefined || flags.binaryPath !== undefined || flags.experimental
          || flags.tunnelIdEnv !== undefined || flags.runtimeKeyEnv !== undefined) {
          throw new Error("tunnel doctor accepts only --config, --timeout-ms and --json");
        }
        const value = await createControlClient(flags.configPath).tunnelDoctor(flags.timeoutMs);
        write(stdout, flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
        return 0;
      }
      if (action === "profile") {
        const profileAction = args[1];
        if (!profileAction || !["list", "status", "start", "stop", "restart", "enable", "disable"].includes(profileAction)) throw new Error("Usage: pi-maestro-gateway tunnel profile list|status|start|stop|restart|enable|disable [PROFILE] [--timeout-ms MS] [--generation N] [--json]");
        const flags = parseTunnelFlags(args.slice(2));
        if (flags.instance !== undefined || flags.localPort !== undefined || flags.binaryPath !== undefined || flags.experimental || flags.tunnelIdEnv !== undefined || flags.runtimeKeyEnv !== undefined) {
          throw new Error("Tunnel profile commands use the persisted profile and do not accept provider-specific overrides");
        }
        const config = await loadGatewayConfig(flags.configPath);
        if (profileAction === "list") {
          if (flags.provider !== undefined || flags.expectedGeneration !== undefined || flags.timeoutMs !== undefined) throw new Error("tunnel profile list accepts only --config and --json");
          write(stdout, flags.json ? JSON.stringify(config.tunnels.profiles) : JSON.stringify(config.tunnels.profiles, null, 2));
          return 0;
        }
        const profileId = flags.provider;
        if (!profileId) throw new Error(`tunnel profile ${profileAction} requires a profile id`);
        const profile = config.tunnels.profiles.find((candidate) => candidate.id === profileId);
        if (!profile) throw new Error(`Unknown tunnel profile: ${profileId}`);
        if (profileAction === "status" && flags.expectedGeneration !== undefined) throw new Error("tunnel profile status does not accept --generation");
        const client = createControlClient(flags.configPath);
        const options = {
          ...(flags.timeoutMs === undefined ? {} : { timeoutMs: flags.timeoutMs }),
          ...(flags.expectedGeneration === undefined ? {} : { expectedGeneration: flags.expectedGeneration }),
        };
        if (profileAction === "enable" || profileAction === "disable") {
          if (profile.lifecycle !== "persistent") throw new Error(`tunnel profile ${profileAction} requires a persistent profile`);
          if (flags.expectedGeneration !== undefined) throw new Error(`tunnel profile ${profileAction} does not accept --generation`);
          const enabled = profileAction === "enable";
          if (enabled && config.tunnels.profiles.some((candidate) => candidate.id !== profile.id && candidate.enabled && candidate.lifecycle === "persistent")) {
            throw new Error("Disable the active persistent tunnel profile before enabling another one");
          }
          let state: unknown;
          const gateway = await client.status();
          if (!enabled && gateway.online) state = typeof client.tunnelProfileStop === "function"
            ? await client.tunnelProfileStop(profile.id, options)
            : await client.tunnelStop(profile.provider, { ...options, instance: profile.id });
          const profiles = config.tunnels.profiles.map((candidate) => candidate.id === profile.id ? { ...candidate, enabled } : candidate);
          await writeGatewayConfigPatch(flags.configPath ?? gatewayConfigPath(), {
            tunnels: { profiles } as never,
            ...(enabled ? {
              server: { disable_localhost_protection: true, trust_proxy_headers: true } as never,
              auth: {
                mode: config.auth.mode === "open" ? "oauth" : config.auth.mode === "bearer" ? "dual" : config.auth.mode,
                oauth: { server_url: profile.publicUrl, tokenTtlMs: config.auth.oauth?.tokenTtlMs ?? 86_400_000 },
              } as never,
            } : {}),
          });
          if (enabled) {
            if (gateway.online) await client.restart();
            state = typeof client.tunnelProfileStart === "function"
              ? await client.tunnelProfileStart(profile.id, options)
              : await client.tunnelStart(profile.provider, { ...options, instance: profile.id });
          }
          const value = { profile: profile.id, enabled, ...(state === undefined ? {} : { state }) };
          write(stdout, flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
          return 0;
        }
        const value = profileAction === "status"
          ? typeof client.tunnelProfileStatus === "function"
            ? await client.tunnelProfileStatus(profile.id, flags.timeoutMs)
            : await client.tunnelStatus(profile.provider, profile.id, flags.timeoutMs)
          : profileAction === "start"
            ? typeof client.tunnelProfileStart === "function"
              ? await client.tunnelProfileStart(profile.id, options)
              : await client.tunnelStart(profile.provider, { ...options, instance: profile.id })
            : profileAction === "stop"
              ? typeof client.tunnelProfileStop === "function"
                ? await client.tunnelProfileStop(profile.id, options)
                : await client.tunnelStop(profile.provider, { ...options, instance: profile.id })
              : typeof client.tunnelProfileRestart === "function"
                ? await client.tunnelProfileRestart(profile.id, options)
                : await client.tunnelRestart(profile.provider, { ...options, instance: profile.id });
        write(stdout, flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
        return 0;
      }
      if (!action || !["status", "start", "stop", "restart"].includes(action)) throw new Error("Usage: pi-maestro-gateway tunnel status|start|stop|restart [PROVIDER] [INSTANCE] [--timeout-ms MS] [--generation N] [--json]");
      const flags = parseTunnelFlags(args.slice(1));
      if (action !== "status" && !flags.provider) throw new Error(`tunnel ${action} requires a provider`);
      if (action === "status" && (flags.expectedGeneration !== undefined || flags.localPort !== undefined || flags.binaryPath !== undefined || flags.experimental || flags.tunnelIdEnv !== undefined || flags.runtimeKeyEnv !== undefined)) throw new Error("tunnel status does not accept start/configuration options");
      if (flags.provider && flags.provider !== "cloudflare" && flags.provider !== "openai" && (flags.localPort !== undefined || flags.binaryPath !== undefined || flags.experimental || flags.tunnelIdEnv !== undefined || flags.runtimeKeyEnv !== undefined)) throw new Error("Tunnel provider-specific options require cloudflare or openai");
      if (flags.provider === "cloudflare" && (flags.experimental || flags.tunnelIdEnv !== undefined || flags.runtimeKeyEnv !== undefined)) throw new Error("--experimental and OpenAI credential references are OpenAI Tunnel options");
      const client = createControlClient(flags.configPath);
      const common = {
        ...(flags.instance === undefined ? {} : { instance: flags.instance }),
        ...(flags.timeoutMs === undefined ? {} : { timeoutMs: flags.timeoutMs }),
        ...(flags.expectedGeneration === undefined ? {} : { expectedGeneration: flags.expectedGeneration }),
        ...(flags.localPort === undefined && flags.binaryPath === undefined && !flags.experimental && flags.tunnelIdEnv === undefined && flags.runtimeKeyEnv === undefined ? {} : { input: flags.provider === "openai" ? {
          ...(flags.experimental ? { experimental: true } : {}),
          ...(flags.localPort === undefined ? {} : { localPort: flags.localPort }),
          ...(flags.binaryPath === undefined ? {} : { binaryPath: flags.binaryPath }),
          ...(flags.tunnelIdEnv === undefined ? {} : { tunnelIdEnv: flags.tunnelIdEnv }),
          ...(flags.runtimeKeyEnv === undefined ? {} : { runtimeKeyEnv: flags.runtimeKeyEnv }),
        } : {
          mode: "quick",
          ...(flags.localPort === undefined ? {} : { localPort: flags.localPort }),
          ...(flags.binaryPath === undefined ? {} : { binaryPath: flags.binaryPath }),
        } }),
      };
      const value = action === "status" ? await client.tunnelStatus(flags.provider, flags.instance, flags.timeoutMs)
        : action === "start" ? await client.tunnelStart(flags.provider!, common)
          : action === "stop" ? await client.tunnelStop(flags.provider!, common)
            : await client.tunnelRestart(flags.provider!, common);
      write(stdout, flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
      return 0;
    }
    if (command === "workspace") {
      const action = args[0];
      if (!action || !["list", "register", "renew", "remove"].includes(action)) throw new Error("Usage: pi-maestro-gateway workspace list|register|renew|remove [PATH_OR_ID] [--ttl SECONDS] [--generation N] [--json]");
      const flags = parseWorkspaceFlags(args.slice(1));
      const client = createControlClient(flags.configPath);
      let value: unknown;
      if (action === "list") {
        if (flags.target !== undefined || flags.ttlSeconds !== undefined || flags.expectedGeneration !== undefined || flags.permanent) throw new Error("workspace list accepts only --config and --json");
        value = await client.listWorkspaces();
      } else {
        if (!flags.target) throw new Error(`workspace ${action} requires a path or workspace ID`);
        if (action === "register") value = await client.registerWorkspace(flags.target, flags.permanent ? 0 : flags.ttlSeconds ?? 300, flags.expectedGeneration);
        else {
          if (flags.permanent) throw new Error(`workspace ${action} does not accept --permanent`);
          if (flags.expectedGeneration === undefined) throw new Error(`workspace ${action} requires --generation`);
          if (action === "renew") value = await client.renewWorkspace(flags.target, flags.ttlSeconds ?? 300, flags.expectedGeneration);
          else {
            if (flags.ttlSeconds !== undefined) throw new Error("workspace remove does not accept --ttl");
            value = { removed: await client.unregisterWorkspace(flags.target, { expectedGeneration: flags.expectedGeneration }) };
          }
        }
      }
      write(stdout, flags.json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
      return 0;
    }
    if (command === "pair") {
      const action = args[0];
      if (!action || !["create", "bootstrap", "list", "revoke"].includes(action)) throw new Error("Usage: pi-maestro-gateway pair create|bootstrap|list|revoke [ID] [--ttl SECONDS] [--label LABEL]");
      const configIndex = args.indexOf("--config");
      const configPath = configIndex < 0 ? undefined : requiredValue(args, configIndex + 1, "--config");
      const purposeIndex = args.indexOf("--purpose");
      if (purposeIndex >= 0) {
        if (action !== "create") throw new Error("Fabric purpose tokens are issued only by pair create");
        const purpose = requiredValue(args, purposeIndex + 1, "--purpose");
        if (purpose !== "fabric-enrollment" && purpose !== "fabric-rotation") throw new Error("--purpose must be fabric-enrollment or fabric-rotation");
        const valueFlags = new Set(["--purpose", "--connector-id", "--token-out", "--ttl", "--generation", "--label", "--config"]);
        for (let index = 1; index < args.length; index += 1) {
          const arg = args[index]!;
          if (!valueFlags.has(arg)) throw new Error(`Unknown Fabric purpose-token option: ${arg}`);
          requiredValue(args, ++index, arg);
        }
        const connectorIndex = args.indexOf("--connector-id");
        const tokenOutIndex = args.indexOf("--token-out");
        if (connectorIndex < 0) throw new Error("Fabric purpose token issuance requires --connector-id");
        if (tokenOutIndex < 0) throw new Error("Fabric purpose token issuance requires --token-out");
        const ttlIndex = args.indexOf("--ttl");
        const generationIndex = args.indexOf("--generation");
        const labelIndex = args.indexOf("--label");
        const ttlSeconds = ttlIndex < 0 ? 600 : positiveCliInteger(requiredValue(args, ttlIndex + 1, "--ttl"), "--ttl");
        if (ttlSeconds > 600) throw new Error("Fabric purpose-token --ttl cannot exceed 600 seconds");
        const generation = generationIndex < 0 ? undefined : positiveCliInteger(requiredValue(args, generationIndex + 1, "--generation"), "--generation");
        if (purpose === "fabric-rotation" && generation === undefined) throw new Error("fabric-rotation requires --generation");
        if (purpose === "fabric-enrollment" && generation !== undefined) throw new Error("fabric-enrollment does not accept --generation");
        const value = await createControlClient(configPath).issueFabricPurposePairing({
          purpose,
          connectorId: requiredValue(args, connectorIndex + 1, "--connector-id"),
          ttlSeconds,
          ...(generation === undefined ? {} : { generation }),
          ...(labelIndex < 0 ? {} : { label: requiredValue(args, labelIndex + 1, "--label") }),
        });
        const issued = value;
        if (typeof issued.token !== "string" || issued.token.length === 0) throw new Error("Gateway returned an invalid purpose-token response");
        const tokenOut = await writePrivateToken(requiredValue(args, tokenOutIndex + 1, "--token-out"), issued.token);
        const { token: _token, ...safe } = issued;
        write(stdout, JSON.stringify({ ...safe, tokenOut }));
        return 0;
      }
      const config = await loadGatewayConfig(configPath);
      const owner = await new GatewayOwnerStore({ ownerPath: config.state.ownerPath }).read();
      if (!owner?.socket) throw new Error(GATEWAY_OFFLINE_MESSAGE);
      const ttlIndex = args.indexOf("--ttl");
      const labelIndex = args.indexOf("--label");
      const data = action === "create" || action === "bootstrap" ? {
        ...(ttlIndex < 0 ? {} : { ttlMs: Number(requiredValue(args, ttlIndex + 1, "--ttl")) * 1000 }),
        ...(labelIndex < 0 ? {} : { label: requiredValue(args, labelIndex + 1, "--label") }),
      } : action === "revoke" ? { id: requiredValue(args, 1, "revoke") } : undefined;
      const value = await requestGatewayIpcControl({ address: owner.socket, ownerToken: owner.ownerToken, action: action === "create" ? "pair" : action === "bootstrap" ? "pair-bootstrap" : action === "list" ? "pair-list" : "pair-revoke", ...(data ? { data } : {}) });
      write(stdout, JSON.stringify(value));
      return 0;
    }
    if (command === "serve") {
      const flags = parseServeFlags(args);
      const daemon = new GatewayDaemon({
        configPath: flags.configPath,
        http: flags.http,
        httpHost: flags.host,
        httpPort: flags.port,
      });
      try {
        await daemon.start();
      } catch (error) {
        if (!(error instanceof GatewayOwnerActiveError) || !error.owner.socket) throw error;
        await waitForExistingGateway(error.owner);
        write(stdout, flags.json ? JSON.stringify({ ok: true, status: "already-running", owner: error.owner }) : `Pi Maestro Gateway is already running (pid ${error.owner.pid}).`);
        return 0;
      }
      const summary = {
        ok: true,
        status: "running",
        pid: process.pid,
        socket: daemon.ipc?.address,
        http: daemon.http?.url,
      };
      write(stdout, flags.json ? JSON.stringify(summary) : `Pi Maestro Gateway running${summary.http ? ` at ${summary.http}` : ""}.`);
      await waitForShutdown(async () => daemon.stop(), daemon.waitUntilStopped());
      return 0;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      write(stdout, [
        "Usage: pi-maestro-gateway <command>",
        "",
        "Commands:",
        "  serve [--config PATH] [--host HOST] [--port PORT] [--no-http] [--json]",
        "  connect --stdio",
        "  config [--config PATH]  # standalone terminal UI; no Pi host required",
        "  config-sync apply",
        "  connector enroll --hub https://HOST --connector-id ID --device-id ID --token-stdin [--ca PATH] [--json]",
        "  connector rotate --expected-generation N --expected-revision N --token-stdin [--ca PATH] [--json]",
        "  connector start|stop|status [--json]  # Fabric Connector for this workspace",
        "  connector revoke ID --expected-revision N --request-id ID [--config PATH] [--json]",
        "  migrate-legacy --dry-run|--apply [--json]",
        "  service install|ensure|start|stop|restart|status|uninstall [--config PATH] [--json]",
        "    install|ensure [--windows-startup | --detached-fallback]",
        "    --windows-startup persists for the next interactive sign-in; it is not a Windows Service.",
        "    In a non-interactive SSH session, ensure guarantees readiness only until that session ends.",
        "  pair create|bootstrap|list|revoke [ID]",
        "  pair create --purpose fabric-enrollment|fabric-rotation --connector-id ID [--generation N] [--ttl SECONDS] --token-out FILE [--config PATH]",
        "  tunnel status|start|stop|restart [PROVIDER] [INSTANCE] [--timeout-ms MS] [--generation N] [--local-port PORT] [--binary PATH] [--json]",
        "  tunnel doctor [--timeout-ms MS] [--config PATH] [--json] (local, read-only, bounded)",
        "  tunnel profile list|status|start|stop|restart|enable|disable [PROFILE] [--timeout-ms MS] [--generation N] [--config PATH] [--json]",
        "    persisted profiles support Cloudflare Quick/Named, OpenAI Secure, and Managed OpenSSH Reverse modes; legacy provider commands remain compatible",
        "    openai is experimental: explicitly configure env references or pass --experimental --tunnel-id-env NAME --runtime-key-env NAME; no auto-download/provisioning",
        "  workspace list [--config PATH] [--json]",
        "  workspace register PATH [--ttl SECONDS | --permanent] [--generation N] [--config PATH] [--json]",
        "  workspace renew PATH_OR_ID --generation N [--ttl SECONDS] [--config PATH] [--json]",
        "  workspace remove PATH_OR_ID --generation N [--config PATH] [--json]",
        "  version [--json]",
        "",
        "Breaking change: MCPX commands, paths, and environment variables are not runtime aliases.",
        "Use /gateway, pi-maestro-gateway, native Gateway config, and the ./gateway/v1 package export.",
      ].join("\n"));
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (command === "config-sync") write(stderr, serializePiConfigApplyError(error));
    else if (command === "migrate-legacy" && args.includes("--json")) write(stderr, serializeGatewayLegacyMigrationError(error));
    else {
      const message = error instanceof Error ? error.message : String(error);
      write(stderr, message || GATEWAY_OFFLINE_MESSAGE);
    }
    return 1;
  }
}

async function waitForExistingGateway(owner: GatewayOwnerRecord): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const socket = await connectGatewayIpc({ address: owner.socket!, ownerToken: owner.ownerToken, timeoutMs: 500 });
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Existing Gateway did not become healthy");
}

async function waitForShutdown(stop: () => Promise<void>, stopped: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    const onSignal = (): void => {
      if (stopping) return;
      void stop().finally(finish);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    void stopped.then(finish);
  });
}
