import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolvePiAgentDirectory(
  env: { PI_CODING_AGENT_DIR?: string } = process.env,
  homeDirectory = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homeDirectory, ".pi", "agent");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homeDirectory, configured.slice(2));
  }
  return resolve(configured);
}
