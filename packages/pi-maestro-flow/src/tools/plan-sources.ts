import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const DOCS_DIR = "docs";
const DECISION_FILE_PATTERN = /decision|architecture|方案|design/i;
const DOCS_PATH_PATTERN = /docs\/[\w.\-/一-龥]+\.md/g;
const SCAN_LIMIT = 5;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function existsUnder(cwd: string, relativePath: string): Promise<boolean> {
  try {
    const target = resolve(cwd, relativePath);
    const root = resolve(cwd);
    if (!target.startsWith(root + sep) && target !== root) return false;
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Detect candidate decision documents for a Plan.
 * Tier 1: explicit `docs/….md` references in the Plan markdown whose filename
 * matches a decision/architecture/方案/design pattern and that exist on disk.
 * Tier 2 (fallback): top-level `docs/` files matching the same pattern,
 * newest first, capped at SCAN_LIMIT.
 * Returns de-duplicated POSIX relative paths.
 */
export async function detectDecisionDocuments(
  markdown: string,
  cwd: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const tier1: string[] = [];
  for (const match of markdown.matchAll(DOCS_PATH_PATTERN)) {
    const rel = match[0];
    if (!DECISION_FILE_PATTERN.test(rel) || seen.has(rel)) continue;
    if (await existsUnder(cwd, rel)) {
      seen.add(rel);
      tier1.push(rel);
    }
  }
  if (tier1.length > 0) return tier1;

  let entries: { name: string; mtimeMs: number }[];
  try {
    const dir = join(cwd, DOCS_DIR);
    const names = await readdir(dir);
    const stats = await Promise.all(
      names
        .filter((name) => name.endsWith(".md") && DECISION_FILE_PATTERN.test(name))
        .map(async (name) => ({
          name,
          mtimeMs: (await stat(join(dir, name))).mtimeMs,
        })),
    );
    entries = stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
  return entries
    .slice(0, SCAN_LIMIT)
    .map((entry) => toPosix(join(DOCS_DIR, entry.name)));
}
