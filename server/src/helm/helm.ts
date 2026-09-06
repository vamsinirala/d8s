import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";

const run = promisify(execFile);

/**
 * Helm operations.
 *
 * Every helm invocation uses execFile with an argument array rather than a shell
 * string. The chart path and values files come from user input, so shell
 * interpolation would be a command-injection hole; execFile passes arguments
 * straight to the process without a shell.
 */

const HELM_TIMEOUT_MS = 30_000;
/** Rendered charts can be large, but not unbounded — cap the pipe. */
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export interface HelmAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export async function checkHelm(): Promise<HelmAvailability> {
  try {
    const { stdout } = await run("helm", ["version", "--short"], { timeout: HELM_TIMEOUT_MS });
    return { available: true, version: stdout.trim() };
  } catch (e: any) {
    return {
      available: false,
      error:
        e?.code === "ENOENT"
          ? "helm was not found on PATH. Install Helm to use this view."
          : String(e?.message ?? e),
    };
  }
}

/** Expands a leading `~` and resolves to an absolute path. */
export function resolveChartPath(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith("~")
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

export interface ChartInfo {
  path: string;
  name: string;
  version?: string;
  appVersion?: string;
  description?: string;
  /** Candidate values files found in the chart, relative to the chart root. */
  valuesFiles: string[];
}

/**
 * Validates that `chartPath` looks like a Helm chart and lists the values files
 * a user might pick, including any inside a conventional `values/` or `envs/`
 * subdirectory.
 */
export async function inspectChart(chartPath: string): Promise<ChartInfo> {
  const dir = resolveChartPath(chartPath);

  if (!existsSync(dir)) throw new Error(`Path does not exist: ${dir}`);
  const dirStat = await stat(dir);
  if (!dirStat.isDirectory()) throw new Error(`Not a directory: ${dir}`);

  const chartYaml = join(dir, "Chart.yaml");
  if (!existsSync(chartYaml)) {
    throw new Error(`No Chart.yaml in ${dir} — this does not look like a Helm chart directory.`);
  }

  const { readFile } = await import("node:fs/promises");
  const parsed = YAML.parse(await readFile(chartYaml, "utf-8")) ?? {};

  const valuesFiles = await findValuesFiles(dir);

  return {
    path: dir,
    name: typeof parsed.name === "string" ? parsed.name : "chart",
    version: parsed.version != null ? String(parsed.version) : undefined,
    appVersion: parsed.appVersion != null ? String(parsed.appVersion) : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    valuesFiles,
  };
}

const VALUES_SUBDIRS = ["", "values", "envs", "environments", "ci"];

async function findValuesFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of VALUES_SUBDIRS) {
    const target = sub ? join(dir, sub) : dir;
    if (!existsSync(target)) continue;
    try {
      for (const entry of await readdir(target, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.ya?ml$/i.test(entry.name)) continue;
        // At the chart root only values*.yaml are candidates; Chart.yaml and
        // friends are not. Inside a values/ dir, any yaml is fair game.
        if (!sub && !/^values.*\.ya?ml$/i.test(entry.name)) continue;
        found.push(sub ? `${sub}/${entry.name}` : entry.name);
      }
    } catch {
      // Unreadable directory — skip rather than fail the whole inspect.
    }
  }
  return found.sort();
}

/** Rejects values paths that escape the chart directory. */
function resolveValuesFile(chartDir: string, relative: string): string {
  const full = resolve(chartDir, relative);
  if (full !== chartDir && !full.startsWith(chartDir + "/")) {
    throw new Error(`Values file must be inside the chart directory: ${relative}`);
  }
  if (!existsSync(full)) throw new Error(`Values file not found: ${relative}`);
  return full;
}

function valuesArgs(chartDir: string, valuesFiles: string[]): string[] {
  return valuesFiles.flatMap((f) => ["-f", resolveValuesFile(chartDir, f)]);
}

export interface LintMessage {
  severity: "info" | "warning" | "error" | "unknown";
  text: string;
}

export interface LintResult {
  ok: boolean;
  messages: LintMessage[];
  raw: string;
}

/** Runs `helm lint`, which covers both YAML/template syntax and chart conventions. */
export async function lintChart(chartDir: string, valuesFiles: string[]): Promise<LintResult> {
  const args = ["lint", chartDir, ...valuesArgs(chartDir, valuesFiles)];
  try {
    const { stdout, stderr } = await run("helm", args, {
      timeout: HELM_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { ok: true, messages: parseLint(stdout + stderr), raw: (stdout + stderr).trim() };
  } catch (e: any) {
    // A non-zero exit means lint found errors — that is a result, not a failure.
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim() || String(e?.message ?? e);
    return { ok: false, messages: parseLint(out), raw: out };
  }
}

function parseLint(output: string): LintMessage[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\[(INFO|WARNING|ERROR)\]\s*(.*)$/i);
      if (m) {
        return { severity: m[1].toLowerCase() as LintMessage["severity"], text: m[2] };
      }
      return { severity: "unknown" as const, text: line };
    });
}

/**
 * Renders the chart with `helm template` and returns the parsed manifests.
 * Rendering is client-side only — it never contacts the cluster and never
 * installs anything.
 */
export async function renderChart(
  chartDir: string,
  valuesFiles: string[],
  releaseName: string,
  namespace: string,
): Promise<Record<string, unknown>[]> {
  const args = [
    "template",
    releaseName,
    chartDir,
    "--namespace",
    namespace,
    ...valuesArgs(chartDir, valuesFiles),
  ];

  let stdout: string;
  try {
    ({ stdout } = await run("helm", args, {
      timeout: HELM_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    }));
  } catch (e: any) {
    const detail = `${e?.stderr ?? ""}`.trim() || String(e?.message ?? e);
    throw new Error(`helm template failed:\n${detail}`);
  }

  return YAML.parseAllDocuments(stdout)
    .map((doc) => doc.toJS({ maxAliasCount: -1 }))
    .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object");
}
