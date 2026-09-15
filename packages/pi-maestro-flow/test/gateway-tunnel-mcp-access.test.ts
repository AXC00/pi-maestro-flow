import assert from "node:assert/strict";
import test from "node:test";
import { gatewayTunnelProfileInput, normalizeGatewayConfig } from "../src/gateway/config.ts";
import {
  gatewayTunnelMcpCredentialPolicy,
  normalizeGatewayTunnelMcpAccess,
  normalizeGatewayTunnelMcpUrl,
} from "../src/gateway/tunnel/mcp-access.ts";
import { projectGatewayTunnelMcpConnectionDescriptor } from "../src/gateway/tunnel/mcp-exposure.ts";

test("MCP access accepts aliases and keeps policy out of provider input", () => {
  const workspaceId = "a".repeat(64);
  const config = normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{
      id: "openai-prod", provider: "openai", mode: "secure", enabled: true,
      public_url: "https://mcp.example.com",
      mcp_access: {
        enabled: true,
        actions: ["gateway.host.status", "fabric.control.endpoint.describe"],
        auth: { kind: "managed-forward", provider: "openai", workspace_id: workspaceId },
        public_url: "https://mcp.example.com/mcp",
      },
    }] },
  });
  const profile = config.tunnels.profiles[0]!;
  assert.deepEqual(profile.mcpAccess, {
    enabled: true,
    actions: ["gateway.host.status", "fabric.control.endpoint.describe"],
    auth: { kind: "managed-forward", provider: "openai", workspaceId },
    publicUrl: "https://mcp.example.com/mcp",
  });
  const input = gatewayTunnelProfileInput(profile, config.transport.http);
  assert.equal(Object.hasOwn(input, "mcpAccess"), false);
  assert.equal(Object.hasOwn(input, "actions"), false);
  assert.equal(Object.hasOwn(input, "auth"), false);
});

test("MCP actions, auth, workspace, and URLs are narrow", () => {
  const valid = { enabled: true, actions: [], auth: { kind: "gateway" } };
  assert.deepEqual(normalizeGatewayTunnelMcpAccess(valid), valid);
  assert.deepEqual(normalizeGatewayTunnelMcpAccess({ enabled: true, scopes: [], auth: { kind: "gateway" } }), valid);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, actions: ["gateway.file.read"], scopes: ["gateway.host.status"] }), /conflicting aliases actions and scopes/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, actions: ["gateway.host.status"] }), /gateway cannot define actions/u);
  assert.equal(normalizeGatewayTunnelMcpAccess({ ...valid, publicUrl: "https://mcp.example.com" }).publicUrl, "https://mcp.example.com");
  const managed = { enabled: true, actions: ["gateway.host.status"], auth: { kind: "managed-forward", provider: "openai" } };
  for (const action of ["gateway", "gateway.*", "gateway.host.*", "fabric.data.file.read", "fabric.control", "fabric.control.*.read", "gateway.enrollment.issue", "gateway.events.list", "gateway.host.status?x"]) {
    assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...managed, actions: [action] }, "mcpAccess", { provider: "openai", mode: "secure" }), /exact Gateway or Fabric control action/u);
  }
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...managed, actions: [] }, "mcpAccess", { provider: "openai", mode: "secure" }), /1–64/u);
  assert.deepEqual(normalizeGatewayTunnelMcpAccess({ enabled: true, auth: { kind: "gateway" } }), valid);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...managed, actions: ["gateway.host.status", "gateway.host.status"] }, "mcpAccess", { provider: "openai", mode: "secure" }), /duplicates/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, auth: { kind: "gateway", workspace: "x" } }), /gateway cannot define/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, publicUrl: "http://mcp.example.com/mcp" }), /HTTPS/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, publicUrl: "https://user:pass@mcp.example.com/mcp" }), /credential/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, publicUrl: "https://mcp.example.com/mcp?token=secret" }), /query/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, publicUrl: "https://mcp.example.com/other" }), /controlled MCP path|HTTPS origin/u);
  assert.throws(() => normalizeGatewayTunnelMcpAccess({ ...valid, auth: { kind: "managed-forward", provider: "openai" } }, "mcpAccess", { provider: "cloudflare", mode: "named" }), /only supported/u);
});

test("gateway auth is an ingress marker and cannot become an allowlist", () => {
  assert.deepEqual(normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{ id: "named", provider: "cloudflare", mode: "named", enabled: true,
      public_url: "https://mcp.example.com", tunnel_id: "named", token_file: "/tmp/token",
      mcp_access: { enabled: true, actions: [], auth: { kind: "gateway" } } }] },
  }).tunnels.profiles[0]!.mcpAccess, { enabled: true, actions: [], auth: { kind: "gateway" } });
  assert.throws(() => normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{ id: "openai", provider: "openai", mode: "secure", enabled: true,
      public_url: "https://mcp.example.com", mcp_access: { enabled: true, actions: [], auth: { kind: "gateway" } } }] },
  }), /managed-forward/u);
  assert.throws(() => gatewayTunnelMcpCredentialPolicy({ enabled: true, actions: [], auth: { kind: "gateway" } }), /cannot issue scoped credentials/u);
});

test("credential policy projects exact enabled actions and managed workspace", () => {
  const workspaceId = "b".repeat(64);
  const access = normalizeGatewayTunnelMcpAccess({
    enabled: true,
    actions: ["gateway.host.status", "fabric.control.endpoint.describe"],
    auth: { kind: "managed-forward", provider: "openai", workspace_id: workspaceId },
  }, "mcpAccess", { provider: "openai", mode: "secure" });
  assert.deepEqual(gatewayTunnelMcpCredentialPolicy(access), {
    scopes: ["gateway.host.status", "fabric.control.endpoint.describe"], workspaceId,
  });
  assert.throws(() => gatewayTunnelMcpCredentialPolicy({ enabled: true, actions: [], auth: { kind: "gateway" } }), /cannot issue scoped credentials/u);
  assert.deepEqual(gatewayTunnelMcpCredentialPolicy(undefined), { scopes: ["gateway.host.status"] });
  assert.deepEqual(gatewayTunnelMcpCredentialPolicy({ ...access, enabled: false }), { scopes: ["gateway.host.status"] });
});

test("connection projection is an allowlist and never exposes runtime secrets", () => {
  const profile = normalizeGatewayConfig({
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{
      id: "openai-prod", provider: "openai", mode: "secure", enabled: true, public_url: "https://mcp.example.com",
      mcpAccess: { enabled: true, actions: ["gateway.host.status"], auth: { kind: "managed-forward", provider: "openai" } },
    }] },
  }).tunnels.profiles[0]!;
  const descriptor = projectGatewayTunnelMcpConnectionDescriptor(profile, {
    httpPath: "/mcp",
    state: { generation: 7, observed: { phase: "ready", endpoint: "https://secret:bearer@mcp.example.com/mcp" } },
  });
  assert.deepEqual(descriptor, {
    profile: "openai-prod", provider: "openai", mode: "secure", fixed: true,
    publicOrigin: "https://mcp.example.com", mcpUrl: "https://mcp.example.com/mcp",
    authKind: "managed-forward", enabled: true, phase: "ready", generation: 7, readiness: true,
  });
  const serialized = JSON.stringify(descriptor);
  for (const forbidden of ["opaqueId", "tunnelId", "runtimeKey", "bearer", "authorization", "argv", "env", "provider detail"]) assert.equal(serialized.includes(forbidden), false);
});

test("custom transport paths are used by connection descriptors", () => {
  const profile = normalizeGatewayConfig({
    transport: { http: { path: "/api/mcp" } },
    auth: { mode: "oauth", oauth: { server_url: "https://mcp.example.com" } },
    tunnels: { profiles: [{
      id: "named", provider: "cloudflare", mode: "named", enabled: true,
      public_url: "https://mcp.example.com", tunnel_id: "named", token_file: "/tmp/token",
      mcp_access: { enabled: true, actions: [], auth: { kind: "gateway" }, public_url: "https://mcp.example.com/api/mcp" },
    }] },
  }).tunnels.profiles[0]!;
  assert.equal(projectGatewayTunnelMcpConnectionDescriptor(profile, { httpPath: "/api/mcp" }).mcpUrl, "https://mcp.example.com/api/mcp");
});

test("MCP paths canonicalize one trailing slash across access and URL projection", () => {
  assert.equal(normalizeGatewayTunnelMcpUrl("https://mcp.example.com/api/mcp/", "url", "/api/mcp/"), "https://mcp.example.com/api/mcp");
  assert.equal(normalizeGatewayTunnelMcpAccess({ enabled: false, public_url: "https://mcp.example.com/api/mcp/", auth: { kind: "gateway" } }, "mcpAccess", { controlledPath: "/api/mcp/" }).publicUrl, "https://mcp.example.com/api/mcp");
});

test("Quick tunnel projection is ephemeral and does not claim fixed URL", () => {
  const profile = normalizeGatewayConfig({ tunnels: { profiles: [{ id: "quick", provider: "cloudflare", mode: "quick", enabled: true, mcp_access: { enabled: false } }] } }).tunnels.profiles[0]!;
  const descriptor = projectGatewayTunnelMcpConnectionDescriptor(profile, { state: { observed: { phase: "ready", endpoint: "https://temporary.example/mcp" } } });
  assert.equal(descriptor.ephemeral, true);
  assert.equal(Object.hasOwn(descriptor, "fixed"), false);
  assert.equal(Object.hasOwn(descriptor, "mcpUrl"), false);
});
