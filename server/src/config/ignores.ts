import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Ignore rules: differences the user has reviewed and chosen to hide.
 *
 * Stored as a JSON file next to environments.json, so there's nothing to
 * install and the rules survive browser data being cleared. They persist
 * until removed individually or cleared.
 *
 *   resource null  → the rule applies to every resource of `kind`
 *   path null      → the whole resource is ignored
 *   path "a.b"     → that field and anything nested beneath it
 *
 * Matching is done in the browser (web/src/ignores.tsx); the server only stores
 * rules, so changing them never invalidates cached cluster data.
 */
export interface IgnoreRule {
  id: string;
  kind: string;
  resource: string | null;
  path: string | null;
  createdAt: number;
}

const CONFIG_DIR = join(homedir(), ".d8s");
const IGNORES_FILE = join(CONFIG_DIR, "ignores.json");

export async function loadIgnores(): Promise<IgnoreRule[]> {
  try {
    return JSON.parse(await readFile(IGNORES_FILE, "utf-8")) as IgnoreRule[];
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveIgnores(rules: IgnoreRule[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  const tmp = `${IGNORES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(rules, null, 2), "utf-8");
  await rename(tmp, IGNORES_FILE);
}

/** Adds a rule, or returns the existing identical one rather than duplicating it. */
export async function addIgnore(
  input: Pick<IgnoreRule, "kind" | "resource" | "path">,
): Promise<IgnoreRule> {
  const rules = await loadIgnores();
  const existing = rules.find(
    (r) => r.kind === input.kind && r.resource === input.resource && r.path === input.path,
  );
  if (existing) return existing;
  const rule: IgnoreRule = { id: randomUUID(), ...input, createdAt: Date.now() };
  await saveIgnores([...rules, rule]);
  return rule;
}

export async function removeIgnore(id: string): Promise<void> {
  const rules = await loadIgnores();
  await saveIgnores(rules.filter((r) => r.id !== id));
}

export async function clearIgnores(): Promise<void> {
  await saveIgnores([]);
}
