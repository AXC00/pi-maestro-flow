import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  advanceApiKey,
  markApiKeyFailed,
  readApiKeys,
  recordApiKeyFailureAndAdvance,
  resolveApiKey,
  updateProviderKeyState,
} from "../src/providers/api-provider-ops.ts";
import { configuredProviderRegistration } from "../src/providers/api-provider-ops.ts";
import type { ApiKeyEntry, ApiKeyPolicy } from "../src/providers/api-provider-config.ts";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-key-manager-"));
  return join(dir, "models.json");
}

function writeModels(path: string, providers: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ providers }, null, 2));
}

test("resolveApiKey falls back to legacy single apiKey when apiKeys absent", () => {
  const config = { apiKey: "sk-legacy" };
  const resolved = resolveApiKey(config, "sticky");
  assert.equal(resolved?.key, "sk-legacy");
  assert.equal(resolved?.id, "legacy");
});

test("resolveApiKey sticky returns activeKeyId", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a" },
      { id: "b", key: "sk-b" },
    ] as ApiKeyEntry[],
    activeKeyId: "b",
  };
  const resolved = resolveApiKey(config, "sticky");
  assert.equal(resolved?.id, "b");
  assert.equal(resolved?.key, "sk-b");
});

test("resolveApiKey round-robin advances from active key", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a" },
      { id: "b", key: "sk-b" },
      { id: "c", key: "sk-c" },
    ] as ApiKeyEntry[],
    activeKeyId: "a",
  };
  const resolved = resolveApiKey(config, "round-robin");
  assert.equal(resolved?.id, "b");
});

test("resolveApiKey failover prefers healthy active key", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a", failureCount: 1, lastFailureAt: Date.now() },
      { id: "b", key: "sk-b" },
    ] as ApiKeyEntry[],
    activeKeyId: "b",
  };
  const resolved = resolveApiKey(config, "failover");
  assert.equal(resolved?.id, "b");
});

test("resolveApiKey failover skips cooling active key", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a", failureCount: 1, lastFailureAt: Date.now() },
      { id: "b", key: "sk-b" },
    ] as ApiKeyEntry[],
    activeKeyId: "a",
  };
  const resolved = resolveApiKey(config, "failover");
  assert.equal(resolved?.id, "b");
});

test("resolveApiKey weighted respects zero weight", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a", weight: 0 },
      { id: "b", key: "sk-b", weight: 1 },
    ] as ApiKeyEntry[],
  };
  // Deterministic: total=1, point lands on b immediately.
  const resolved = resolveApiKey(config, "weighted");
  assert.equal(resolved?.id, "b");
});

test("markApiKeyFailed increments failure count and timestamp", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a" },
      { id: "b", key: "sk-b" },
    ] as ApiKeyEntry[],
  };
  const next = markApiKeyFailed(config, "a", 429);
  assert.ok(next);
  const a = next!.find((entry) => entry.id === "a")!;
  assert.equal(a.failureCount, 1);
  assert.equal(a.lastFailureStatus, 429);
  assert.ok(typeof a.lastFailureAt === "number");
});

test("advanceApiKey failover moves to healthiest non-excluded key", () => {
  const config = {
    apiKeys: [
      { id: "a", key: "sk-a", failureCount: 1, lastFailureAt: Date.now() },
      { id: "b", key: "sk-b" },
    ] as ApiKeyEntry[],
    activeKeyId: "a",
    keyPolicy: "failover" as ApiKeyPolicy,
  };
  const advanced = advanceApiKey(config, "failover", "a");
  assert.equal(advanced?.activeKeyId, "b");
});

test("updateProviderKeyState persists key changes", async () => {
  const modelsPath = tmpFile();
  writeModels(modelsPath, {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKeys: [
        { id: "a", key: "sk-a" },
        { id: "b", key: "sk-b" },
      ] as ApiKeyEntry[],
      activeKeyId: "a",
    },
  });
  const result = await updateProviderKeyState(
    "openai",
    () => ({ activeKeyId: "b" }),
    modelsPath,
  );
  assert.ok(result);
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, unknown> };
  assert.equal((written.providers.openai as Record<string, unknown>).activeKeyId, "b");
  rmSync(dirname(modelsPath), { recursive: true, force: true });
});

test("recordApiKeyFailureAndAdvance marks failure and switches key", async () => {
  const modelsPath = tmpFile();
  writeModels(modelsPath, {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKeys: [
        { id: "a", key: "sk-a" },
        { id: "b", key: "sk-b" },
      ] as ApiKeyEntry[],
      activeKeyId: "a",
      keyPolicy: "failover",
    },
  });
  const switched = await recordApiKeyFailureAndAdvance("openai", "a", 429, modelsPath);
  assert.ok(switched);
  assert.equal(switched!.activeKeyId, "b");
  const written = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, unknown> };
  const openai = written.providers.openai as Record<string, unknown>;
  const keys = readApiKeys(openai);
  const a = keys.find((key) => key.id === "a")!;
  assert.equal(a.failureCount, 1);
  assert.equal(a.lastFailureStatus, 429);
  rmSync(dirname(modelsPath), { recursive: true, force: true });
});

test("configuredProviderRegistration picks active key from apiKeys", () => {
  const modelsPath = tmpFile();
  writeModels(modelsPath, {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKeys: [
        { id: "a", key: "sk-a" },
        { id: "b", key: "sk-b" },
      ] as ApiKeyEntry[],
      activeKeyId: "b",
      models: [{ id: "gpt-5.6" }],
    },
  });
  const registration = configuredProviderRegistration("openai", modelsPath);
  assert.equal(registration.apiKey, "sk-b");
  rmSync(dirname(modelsPath), { recursive: true, force: true });
});

test("configuredProviderRegistration keeps legacy apiKey when apiKeys absent", () => {
  const modelsPath = tmpFile();
  writeModels(modelsPath, {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKey: "sk-legacy",
      models: [{ id: "gpt-5.6" }],
    },
  });
  const registration = configuredProviderRegistration("openai", modelsPath);
  assert.equal(registration.apiKey, "sk-legacy");
  rmSync(dirname(modelsPath), { recursive: true, force: true });
});

