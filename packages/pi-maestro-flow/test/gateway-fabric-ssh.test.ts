import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_CONTROL_SSH_COMMAND,
  TEAMMATE_RUNTIME_SSH_COMMAND,
  type GatewayControlSshOpenRequest,
  type TeammateRuntimeSshOpenRequest,
} from "pi-maestro-fabric/fixed-ssh-channel";
import { principalHasFabricDataPlane } from "../src/gateway/capabilities.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayFabricSshTransport } from "../src/gateway/fabric/ssh-transport.ts";

test("Fabric data-plane capabilities exclude open and legacy Gateway grants", () => {
  assert.equal(principalHasFabricDataPlane(createGatewayPrincipal("http", "open", { authenticated: false, scopes: ["gateway"] }), "exchange"), false);
  assert.equal(principalHasFabricDataPlane(createGatewayPrincipal("http", "legacy", { authenticated: true, scopes: ["gateway"] }), "exchange"), false);
  assert.equal(principalHasFabricDataPlane(createGatewayPrincipal("http", "paired", { authenticated: true, scopes: ["fabric.data.exchange"] }), "exchange"), true);
  assert.equal(principalHasFabricDataPlane(createGatewayPrincipal("http", "paired", { authenticated: true, scopes: ["fabric.data.exchange"] }), "events"), false);
});

test("Flow SSH transport preserves both fixed protocols and rejects MCP over control SSH", async () => {
  const gatewayRequests: GatewayControlSshOpenRequest[] = [];
  const teammateRequests: TeammateRuntimeSshOpenRequest[] = [];
  const transport = new GatewayFabricSshTransport({
    gatewayControlOpener: {
      async open(request) {
        gatewayRequests.push(request);
        return { descriptor: { ...request, hostDigest: "gateway-digest", fence: "gateway-fence" }, handle: { protocol: "control" }, async close() {} };
      },
    },
    teammateRuntimeOpener: {
      async open(request) {
        teammateRequests.push(request);
        return { descriptor: { ...request, hostDigest: "teammate-digest", fence: "teammate-fence" }, handle: { protocol: "runtime" }, async close() {} };
      },
    },
  });
  const signal = new AbortController().signal;
  const gateway = await transport.openGatewayControl("host-1", signal);
  const teammate = await transport.openTeammateRuntime("host-1", signal);
  assert.equal(gatewayRequests[0]?.command, GATEWAY_CONTROL_SSH_COMMAND);
  assert.equal(teammateRequests[0]?.command, TEAMMATE_RUNTIME_SSH_COMMAND);
  assert.notEqual(gateway.descriptor.command, teammate.descriptor.command);
  assert.deepEqual(gateway.handle, { protocol: "control" });
  assert.deepEqual(teammate.handle, { protocol: "runtime" });
  assert.throws(() => transport.openMcp("host-1", signal), /control-only fixed SSH adapters/);
});
