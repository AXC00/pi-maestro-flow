import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { lockSettingsResource } from "../src/settings/resource-lock.ts";

test("a lock removed beneath its holder warns instead of killing the process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-lock-"));
  const target = path.join(root, "settings.json");
  const release = await lockSettingsResource(target);

  try {
    const lockDir = `${path.resolve(target)}.lock`;
    assert.ok(fs.existsSync(lockDir), "the lock directory exists while the lock is held");

    // proper-lockfile checks the lock from its mtime-update timer (update: 2s),
    // so the compromise is reported asynchronously rather than at removal time.
    const reported = new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the renewal timer never reported the compromised lock")),
        20_000,
      );
      const onWarning = (warning: Error) => {
        if (!/compromised/i.test(warning.message)) {
          return;
        }
        clearTimeout(timer);
        process.off("warning", onWarning);
        resolve(warning);
      };
      process.on("warning", onWarning);
    });

    fs.rmSync(lockDir, { recursive: true, force: true });

    const warning = await reported;
    assert.match(warning.message, /continuing without mutual exclusion/);
  } finally {
    // A compromised lock is already gone, so releasing it only reports that state.
    await release().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
