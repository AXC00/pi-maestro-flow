import assert from "node:assert/strict";
import test from "node:test";
import type { FabricTeammateRuntimePort } from "../src/public/v1/fabric-runtime.ts";
import {
  getFabricTeammateRuntimePort,
  registerFabricTeammateRuntimePort,
} from "../src/public/v1/fabric-runtime.ts";

function port(label: string): FabricTeammateRuntimePort {
  return {
    async startAttempt() {
      throw new Error(`unused ${label}`);
    },
  };
}

test("Fabric source runtime registration is replaceable without stale disposer removal", () => {
  const first = port("first");
  const second = port("second");
  const firstRegistration = registerFabricTeammateRuntimePort(first);
  const secondRegistration = registerFabricTeammateRuntimePort(second);

  assert.equal(getFabricTeammateRuntimePort(), second);
  firstRegistration.dispose();
  assert.equal(getFabricTeammateRuntimePort(), second, "stale disposer removed the replacement runtime");
  secondRegistration.dispose();
  assert.equal(getFabricTeammateRuntimePort(), undefined);
});

test("Fabric source runtime registration rejects a non-port", () => {
  assert.throws(
    () => registerFabricTeammateRuntimePort({} as FabricTeammateRuntimePort),
    /must implement startAttempt/,
  );
});
