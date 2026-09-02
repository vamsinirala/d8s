import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Environment {
  id: string;
  label: string;
  context: string;
  namespace: string;
}

const CONFIG_DIR = join(homedir(), ".d8s");
const CONFIG_FILE = join(CONFIG_DIR, "environments.json");

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadEnvironments(): Promise<Environment[]> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Environment[];
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveEnvironments(envs: Environment[]): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(envs, null, 2), "utf-8");
}

export async function addEnvironment(
  input: Omit<Environment, "id">,
): Promise<Environment> {
  const envs = await loadEnvironments();
  const env: Environment = { id: randomUUID(), ...input };
  envs.push(env);
  await saveEnvironments(envs);
  return env;
}

export async function removeEnvironment(id: string): Promise<void> {
  const envs = await loadEnvironments();
  await saveEnvironments(envs.filter((e) => e.id !== id));
}
