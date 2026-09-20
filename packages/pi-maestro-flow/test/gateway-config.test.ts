import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GatewayConfigValidationError,
  applyGatewayConfigPatch,
  defaultGatewayConfig,
  gatewayTunnelProfileInput,
  loadGatewayConfig,
  normalizeGatewayConfig,
  parseGatewayConfigDocument,
  writeGatewayConfigPatch,
} from "../src/gateway/config.ts";
import { createGatewayStatePaths, gatewayBoardPath, gatewayBoardRoot, gatewayHandoffRoot, gatewayMaestroReceiptRoot } from "../src/gateway/state-paths.ts";

const yaml = `# keep this header\nversion: 2\nserver:\n    host: "127.0.0.1"\n    port: 9191\nauth:\n    mode: bearer\n    token: "secret"\nsecurity:\n    commands:\n        default: confirm\n        allow:\n            - "^pi\\\\b"\n        confirm: []\n        deny: []\n        auto_allow_readonly: null\n    files:\n        max_read_bytes: 2048\n        max_patch_files: 3\n        allow: []\n        confirm: []\n        deny: []\nworkspaces:\n    - path: "."\n      ttl_seconds: 60\ntransport:\n    stdio:\n        enabled: true\nlimits:\n    max_request_bytes: 2048\nlogging:\n    level: info\nstate:\n    root_dir: ".pi/gateway/v1"\nretention:\n    jobs: 3600\nunknown_section:\n    keep: true\n    comment: "must survive"\n`;

test("Gateway config normalizes legacy snake-case sections and rejects invalid known fields", () => {
  const document = parseGatewayConfigDocument(yaml);
  assert.equal(document.config.version, 2);
  assert.equal(document.config.server.port, 9191);
  assert.equal(document.config.transport.http.host, "127.0.0.1");
  assert.equal(document.config.transport.http.port, 9191);
  assert.equal(document.config.security.commands.default, "confirm");
  assert.equal(document.config.security.files.maxReadBytes, 2048);
  assert.equal(document.config.limits.maxRequestBytes, 2048);
  assert.equal(document.config.workspaces[0]?.ttlMs, 60_000);
  assert.deepEqual(document.unknownSections.unknown_section, { keep: true, comment: "must survive" });

  assert.equal(normalizeGatewayConfig({}).version, 2);
  assert.throws(() => normalizeGatewayConfig({ version: 1 }), /config\.version must be 2/);
  assert.throws(() => normalizeGatewayConfig({ version: 3 }), /config\.version must be 2/);
  assert.throws(() => normalizeGatewayConfig({ server: { port: "9191" } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ security: { commands: { default: "maybe" } } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ limits: { max_request_bytes: 99_999_999 } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ transport: { http: { port: 0 } } }), GatewayConfigValidationError);
  assert.throws(() => normalizeGatewayConfig({ transport: { http: { tls: { enabled: true } } } }), /requires certFile and keyFile/);
  assert.throws(() => normalizeGatewayConfig({ security: { trustedFullAccess: { enabled: true, workspaceRoots: ["."] } } }), /auth.mode cannot be open/);
  const trusted = normalizeGatewayConfig({ auth: { mode: "bearer", token: "secret" }, security: { trusted_full_access: { enabled: true, workspace_roots: ["."] } }, transport: { http: { tls: { enabled: true, cert_file: "cert.pem", key_file: "key.pem" } } } });
  assert.deepEqual(trusted.security.trustedFullAccess, { enabled: true, workspaceRoots: ["."] });
  assert.equal(trusted.transport.http.tls.enabled, true);
  assert.equal(normalizeGatewayConfig({ auth: { mode: "oauth", oauth: { password: "pw", token_secret: "legacy-secret" } } }).auth.mode, "oauth");
  assert.equal(normalizeGatewayConfig({ auth: { mode: "open" } }).auth.allowOpenMutations, undefined);
  assert.equal(normalizeGatewayConfig({ auth: { mode: "open", allow_open_mutations: false } }).auth.allowOpenMutations, false);
  assert.equal(normalizeGatewayConfig({ auth: { mode: "open", allowOpenMutations: true } }).auth.allowOpenMutations, true);
  assert.throws(() => normalizeGatewayConfig({ auth: { mode: "open", allow_open_mutations: "yes" } }), /allowOpenMutations must be boolean/);
  const openAiTunnel = normalizeGatewayConfig({ tunnels: { openai: {
    enabled: true,
    auto_install: true,
    binary_path: "/opt/openai/tunnel-client",
    tunnel_id_env: "MY_TUNNEL_ID",
    runtime_key_env: "MY_RUNTIME_KEY",
    minimum_version: "0.0.14",
    credential_ttl_ms: 60_000,
  } } }).tunnels.openai;
  assert.deepEqual(openAiTunnel, {
    enabled: true,
    autoInstall: true,
    binaryPath: "/opt/openai/tunnel-client",
    tunnelIdEnv: "MY_TUNNEL_ID",
    runtimeKeyEnv: "MY_RUNTIME_KEY",
    minimumVersion: "0.0.14",
    credentialTtlMs: 60_000,
  });
  assert.equal(normalizeGatewayConfig({}).tunnels.openai.autoInstall, false);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { openai: { runtime_key: "literal-secret" } } }), /not a recognized field/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { openai: { runtime_key_env: "bad-name" } } }), /environment variable name/);
  const tunnelProfiles = normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [
      { id: "quick", provider: "cloudflare", mode: "quick", enabled: true },
      { id: "production", provider: "cloudflare", mode: "named", enabled: true, public_url: "https://mcp.example.com", tunnel_id: "8c4a2d42-5ac8-4bf8-a0f1-4ebd8e59e101", credentials_file: "/secure/cloudflared.json", local_port: 9191 },
    ] },
  }).tunnels.profiles;
  assert.deepEqual(tunnelProfiles, [
    { id: "quick", provider: "cloudflare", mode: "quick", enabled: true, lifecycle: "ephemeral" },
    { id: "production", provider: "cloudflare", mode: "named", enabled: true, lifecycle: "persistent", publicUrl: "https://mcp.example.com", tunnelId: "8c4a2d42-5ac8-4bf8-a0f1-4ebd8e59e101", credentialsFile: "/secure/cloudflared.json", localPort: 9191 },
  ]);
  const openAiProfile = normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://openai.example.com" } },
    tunnels: { profiles: [{ id: "openai-prod", provider: "openai", mode: "secure", enabled: true, public_url: "https://openai.example.com", auto_install: true }] },
  }).tunnels.profiles[0];
  assert.deepEqual(openAiProfile, {
    id: "openai-prod", provider: "openai", mode: "secure", lifecycle: "persistent", enabled: true,
    publicUrl: "https://openai.example.com", tunnelIdEnv: "CONTROL_PLANE_TUNNEL_ID", runtimeKeyEnv: "CONTROL_PLANE_API_KEY", credentialTtlMs: 300_000, autoInstall: true,
  });
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad-quick", provider: "cloudflare", mode: "quick", auto_install: true }] } }), /persistent-provider fields/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad", provider: "cloudflare", mode: "named", public_url: "https://mcp.example.com", tunnel_id: "prod", token: "literal-secret" }] } }), /not a recognized field/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad", provider: "cloudflare", mode: "named", public_url: "https://mcp.example.com", tunnel_id: "prod" }] } }), /exactly one/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad-quick", provider: "cloudflare", mode: "quick", runtime_key_env: "RUNTIME_KEY" }] } }), /persistent-provider fields/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad-named", provider: "cloudflare", mode: "named", enabled: false, public_url: "https://mcp.example.com", tunnel_id: "prod", token_file: "/secure/token", runtime_key_env: "RUNTIME_KEY" }] } }), /cannot define OpenAI fields/);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ id: "bad-openai", provider: "openai", mode: "secure", enabled: false, public_url: "https://openai.example.com", token_file: "/secure/token" }] } }), /cannot define Cloudflare Named fields/);
  assert.throws(() => normalizeGatewayConfig({ auth: { mode: "oauth", oauth: { server_url: "https://other.example.com" } }, tunnels: { profiles: [{ id: "bad", provider: "cloudflare", mode: "named", public_url: "https://mcp.example.com", tunnel_id: "prod", token_file: "/secure/token" }] } }), /must match/);
  assert.throws(() => normalizeGatewayConfig({ auth: { mode: "oauth", oauth: { server_url: "https://openai.example.com" } }, tunnels: { profiles: [{ id: "openai-fast", provider: "openai", mode: "secure", public_url: "https://openai.example.com", credential_ttl_ms: 1_000 }] } }), /credentialTtlMs/);
  assert.throws(() => normalizeGatewayConfig({ auth: { mode: "oauth", oauth: { server_url: "https://one.example.com" } }, tunnels: { profiles: [
    { id: "one", provider: "cloudflare", mode: "named", public_url: "https://one.example.com", tunnel_id: "one", token_file: "/secure/one" },
    { id: "two", provider: "openai", mode: "secure", public_url: "https://two.example.com" },
  ] } }), /Only one persistent/);
  assert.equal(normalizeGatewayConfig({ state: { sessions_root: ".pi/gateway/v1/sessions" } }).state.sessionsRoot, ".pi/gateway/v1/sessions");
  const governed = normalizeGatewayConfig({
    auth: { mode: "bearer", token: "secret" },
    security: {
      skills: { enabled: true, workspace_roots: [".pi/skills"], external_skill_roots: ["D:/approved-skills"], external_reference_roots: ["D:/approved-references"] },
      maestro_cli: { enabled: true, executable: "maestro", minimum_version: "2.0.0", allow_search: true, allow_load: true, allow_stage: false },
    },
    limits: { max_handoff_records: 32, max_skill_files: 16, max_skill_file_bytes: 2048, max_skill_response_bytes: 4096, max_maestro_output_bytes: 8192, max_maestro_timeout_ms: 1000 },
    state: { handoff_root: ".pi/gateway/v1/handoffs", maestro_receipt_root: ".pi/gateway/v1/maestro-receipts" },
  });
  assert.deepEqual(governed.security.skills.externalSkillRoots, ["D:/approved-skills"]);
  assert.equal(governed.security.maestroCli.allowStage, false);
  assert.equal(governed.limits.maxSkillFileBytes, 2048);
  assert.equal(governed.state.maestroReceiptRoot, ".pi/gateway/v1/maestro-receipts");
  assert.throws(() => normalizeGatewayConfig({ security: { skills: { enabled: true } } }), /require authenticated HTTP/);
  assert.throws(() => normalizeGatewayConfig({ auth: { mode: "bearer", token: "secret" }, security: { skills: { typo: true } } }), /not a recognized field/);
  assert.throws(() => normalizeGatewayConfig({ limits: { max_skill_files: 999999 } }), /maxSkillFiles/);
  const boardConfig = normalizeGatewayConfig({
    state: { board_root: ".pi/gateway/v1/board" },
    limits: { max_board_tasks: 32, max_board_operations: 64, max_board_events: 128 },
    retention: { board_tasks: 1_000, board_operations_ms: 2_000, boardEventsMs: 3_000 },
  });
  assert.equal(boardConfig.state.boardRoot, ".pi/gateway/v1/board");
  assert.equal(boardConfig.limits.maxBoardTasks, 32);
  assert.equal(boardConfig.limits.maxBoardOperations, 64);
  assert.equal(boardConfig.limits.maxBoardEvents, 128);
  assert.deepEqual(
    [boardConfig.retention.boardTasksMs, boardConfig.retention.boardOperationsMs, boardConfig.retention.boardEventsMs],
    [1_000, 2_000, 3_000],
  );
  const legacyListener = normalizeGatewayConfig({ server: { host: "0.0.0.0", port: 9293 } });
  assert.equal(legacyListener.transport.http.host, "0.0.0.0");
  assert.equal(legacyListener.transport.http.port, 9293);
  const legacyWorkspaces = normalizeGatewayConfig({ workspaces: [
    { name: "permanent", path: "D:/permanent" },
    { name: "leased", path: "D:/leased", expires_at: new Date(Date.now() + 60_000).toISOString(), owner_token: "legacy" },
  ] });
  assert.equal(legacyWorkspaces.workspaces[0]?.mode, "permanent");
  assert.equal(legacyWorkspaces.workspaces[1]?.mode, "lease");
  assert.ok((legacyWorkspaces.workspaces[1]?.ttlMs ?? 0) > 0);

  const mcpxCompatible = normalizeGatewayConfig({
    auth: {
      mode: "oauth",
      oauth_client_id: "flat-client",
      oauth_client_secret: "flat-secret",
      oauth: {
        password: "pw",
        client_id: "nested-client",
        client_secret: "nested-secret",
        redirect_uris: [],
      },
    },
    security: { files: { max_patch_lines: 2_000 } },
    state: { retention: { enabled: true } },
    transport: { session_idle_ttl: "24h" },
    limits: { max_result_bytes: 262_144 },
    logging: { enabled: true, dir: "" },
  });
  assert.equal(mcpxCompatible.auth.oauth?.password, "pw");
  assert.equal(mcpxCompatible.limits.maxOutputBytes, 262_144);

  const flatOauth = normalizeGatewayConfig({ auth: {
    mode: "oauth",
    oauth_password: "flat-password",
    oauth_server_url: "https://gateway.example.com",
    oauth_token_ttl: 60,
    oauth_client_id: "flat-client",
  } });
  assert.equal(flatOauth.auth.oauth?.password, "flat-password");
  assert.equal(flatOauth.auth.oauth?.serverUrl, "https://gateway.example.com");
  assert.equal(flatOauth.auth.oauth?.tokenTtlMs, 60_000);
  assert.throws(() => normalizeGatewayConfig({ auth: { oauth_client_typo: "no" } }), /auth\.oauth_client_typo is not a recognized field/);
});

test("Gateway config validates and projects persistent SSH Reverse profiles", () => {
  const identityFile = join(tmpdir(), "id_ed25519");
  const config = normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{
      id: "ssh-prod",
      provider: "ssh",
      mode: "reverse",
      lifecycle: "persistent",
      enabled: true,
      public_url: "https://mcp.example.com",
      host: "gateway-edge.example.net",
      user: "tunnel",
      port: 2222,
      remote_bind_host: "127.0.0.1",
      remote_port: 19090,
      local_host: "127.0.0.1",
      identity_file: identityFile,
      connect_timeout_seconds: 20,
      server_alive_interval_seconds: 30,
      server_alive_count_max: 4,
    }] },
  });
  const profile = config.tunnels.profiles[0];
  assert.deepEqual(profile, {
    id: "ssh-prod",
    provider: "ssh",
    mode: "reverse",
    lifecycle: "persistent",
    enabled: true,
    publicUrl: "https://mcp.example.com",
    host: "gateway-edge.example.net",
    user: "tunnel",
    port: 2222,
    remoteBindHost: "127.0.0.1",
    remotePort: 19090,
    localHost: "127.0.0.1",
    identityFile,
    connectTimeoutSeconds: 20,
    serverAliveIntervalSeconds: 30,
    serverAliveCountMax: 4,
  });
  assert.deepEqual(gatewayTunnelProfileInput(profile!, { port: 9090, path: "/mcp" }), {
    mode: "reverse",
    localPort: 9090,
    mcpPath: "/mcp",
    publicUrl: "https://mcp.example.com",
    host: "gateway-edge.example.net",
    user: "tunnel",
    port: 2222,
    remoteBindHost: "127.0.0.1",
    remotePort: 19090,
    localHost: "127.0.0.1",
    identityFile,
    connectTimeoutSeconds: 20,
    serverAliveIntervalSeconds: 30,
    serverAliveCountMax: 4,
  });

  const base = { tunnels: { profiles: [{ id: "bad", provider: "ssh", mode: "reverse", enabled: false, public_url: "https://mcp.example.com", host: "edge", remote_port: 19090 }] } };
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], lifecycle: "ephemeral" }] } }), /must be persistent/u);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], host: "-oProxyCommand=bad" }] } }), /safe SSH host/u);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], remote_bind_host: "0.0.0.0" }] } }), /must be loopback/u);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], identity_file: "relative/id" }] } }), /absolute path/u);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], public_url: "https://mcp.example.com/mcp" }] } }), /exact credential-free HTTPS origin/u);
  assert.throws(() => normalizeGatewayConfig({ tunnels: { profiles: [{ ...base.tunnels.profiles[0], tunnel_id: "wrong-provider" }] } }), /another provider/u);
});

test("Gateway config writes SSH Reverse profile fields in canonical snake case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-ssh-reverse-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "config.yaml");
  const identityFile = join(root, "id_ed25519");
  const updated = await writeGatewayConfigPatch(path, { tunnels: { profiles: [{
    id: "ssh-prod",
    provider: "ssh",
    mode: "reverse",
    lifecycle: "persistent",
    enabled: false,
    publicUrl: "https://mcp.example.com",
    host: "edge",
    remoteBindHost: "127.0.0.1",
    remotePort: 19090,
    localHost: "127.0.0.1",
    identityFile,
    port: 22,
    connectTimeoutSeconds: 10,
    serverAliveIntervalSeconds: 15,
    serverAliveCountMax: 3,
  }] } });
  assert.equal(updated.config.tunnels.profiles[0]?.provider, "ssh");
  assert.match(updated.raw, /remote_bind_host: 127\.0\.0\.1/u);
  assert.match(updated.raw, /remote_port: 19090/u);
  assert.match(updated.raw, /identity_file:/u);
  assert.match(updated.raw, /server_alive_interval_seconds: 15/u);
  assert.equal((await loadGatewayConfig(path)).tunnels.profiles[0]?.mode, "reverse");
});

test("Gateway config patch distinguishes omitted preserve, array replace, object merge, and null clear", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "config.yaml");
  await writeFile(path, yaml, "utf8");

  // Omitted nested fields are preserved, while one field is replaced.
  let updated = await writeGatewayConfigPatch(path, { server: { port: 9292 } as never });
  assert.equal(updated.config.server.port, 9292);
  assert.equal(updated.config.server.host, "127.0.0.1");
  assert.match(updated.raw, /unknown_section:/);
  assert.match(updated.raw, /comment: "must survive"/);

  // Arrays replace the selected list rather than append to it.
  updated = await writeGatewayConfigPatch(path, { security: { commands: { allow: ["echo *"] } } } as never);
  assert.deepEqual(updated.config.security.commands.allow, ["echo *"]);
  assert.equal(updated.config.security.commands.default, "confirm");

  // Null clears a field/section at the write boundary; normalized reads use defaults.
  updated = await writeGatewayConfigPatch(path, { state: null });
  assert.deepEqual(updated.config.state, {});
  const rawAfterClear = await readFile(path, "utf8");
  assert.doesNotMatch(rawAfterClear, /^state:/m);
  assert.match(rawAfterClear, /^unknown_section:/m);

  const loaded = await loadGatewayConfig(path);
  assert.equal(loaded.server.port, 9292);
  assert.equal(loaded.security.commands.allow[0], "echo *");

  const nativePath = join(root, "native-config.yaml");
  const native = await writeGatewayConfigPatch(nativePath, { server: { port: 9393 } as never });
  assert.equal(native.config.version, 2);
  assert.match(await readFile(nativePath, "utf8"), /^version: 2$/m);

  const withProfile = await writeGatewayConfigPatch(nativePath, { tunnels: { profiles: [{
    id: "production", provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: false,
    publicUrl: "https://mcp.example.com", tunnelId: "production", tokenFile: "/secure/cloudflared.token",
  }] } as never });
  assert.equal(withProfile.config.tunnels.profiles[0]?.id, "production");
  assert.match(withProfile.raw, /public_url: https:\/\/mcp\.example\.com/u);
  assert.match(withProfile.raw, /token_file: \/secure\/cloudflared\.token/u);
});

test("default config is canonical and patch application keeps omitted values", () => {
  const base = defaultGatewayConfig();
  assert.equal(base.version, 2);
  assert.equal(base.tunnels.openai.enabled, false, "OpenAI Tunnel remains experimental/disabled by default");
  assert.equal(base.tunnels.openai.runtimeKeyEnv, "CONTROL_PLANE_API_KEY");
  assert.deepEqual(base.tunnels.profiles, []);
  assert.equal(base.limits.maxBoardTasks, 1024);
  assert.ok(base.retention.boardTasksMs > 0);
  const paths = createGatewayStatePaths(process.cwd(), tmpdir());
  assert.equal(paths.boardRoot, gatewayBoardRoot(process.cwd()));
  assert.equal(paths.boardPath, gatewayBoardPath(process.cwd()));
  assert.equal(paths.handoffRoot, gatewayHandoffRoot(process.cwd()));
  assert.equal(paths.maestroReceiptRoot, gatewayMaestroReceiptRoot(process.cwd()));
  const patched = applyGatewayConfigPatch(base, { server: { port: 9999 } as never });
  assert.equal(patched.server.port, 9999);
  assert.equal(patched.server.host, base.server.host);
  const cleared = applyGatewayConfigPatch(patched, { logging: null, server: { port: null } as never });
  assert.equal(cleared.logging.level, "info");
  assert.equal(cleared.server.port, 9090);
});

test("Gateway tunnel guide YAML examples parse and linked entry points resolve", async () => {
  const guidePath = join(import.meta.dirname, "../../../docs/gateway-tunnel-configuration.md");
  const guide = await readFile(guidePath, "utf8");
  const examples = [...guide.matchAll(/```yaml\r?\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  assert.equal(examples.length, 6);
  for (const example of examples) assert.equal(parseGatewayConfigDocument(example).config.version, 2);

  const gatewayDesign = await readFile(join(import.meta.dirname, "../../../docs/gateway-command-mcp-tool-design.md"), "utf8");
  const fabricReadme = await readFile(join(import.meta.dirname, "../../../docs/fabric/README.md"), "utf8");
  assert.match(gatewayDesign, /\[Gateway Tunnel 配置指南\]\(\.\/gateway-tunnel-configuration\.md\)/u);
  assert.match(fabricReadme, /\[Current Gateway tunnel configuration\]\(\.\.\/gateway-tunnel-configuration\.md\)/u);
});
