import { flatten } from "../k8s/normalize.js";

/**
 * Strips an environment's own label from a resource name so resources that only
 * differ by an env-suffix/prefix (e.g. "payments-dev-app" vs "payments-prod-app")
 * still match as "the same resource" across environments. Falls back to the
 * original name whenever the label isn't found as a whole token, so plain
 * env-agnostic names (e.g. "api", "frontend") are left untouched.
 */
export function canonicalName(name: string, envLabel: string): string {
  if (!envLabel) return name;
  const escaped = envLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[-_])${escaped}([-_]|$)`, "i");
  const replaced = name.replace(pattern, (_match, pre: string, post: string) =>
    pre && post ? "-" : "",
  );
  const cleaned = replaced.replace(/^[-_]+|[-_]+$/g, "").replace(/[-_]{2,}/g, "-");
  return cleaned || name;
}

function resourceName(resource: Record<string, unknown>): string | undefined {
  const metadata = resource.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.name === "string" ? (metadata.name as string) : undefined;
}

export interface EnvResourceInput {
  envId: string;
  label: string;
  resources: Record<string, unknown>[];
}

export interface OverviewRow {
  canonicalName: string;
  namesByEnv: Record<string, string | null>;
  presentEnvIds: string[];
  missingEnvIds: string[];
  /** Count of field paths that differ across envs where this resource is present. Null if present in <2 envs. */
  diffFieldCount: number | null;
}

function countDifferingPaths(flattenedList: Record<string, unknown>[]): number {
  const allPaths = new Set<string>();
  for (const flat of flattenedList) for (const path of Object.keys(flat)) allPaths.add(path);
  let count = 0;
  for (const path of allPaths) {
    const values = flattenedList.map((flat) => (path in flat ? JSON.stringify(flat[path]) : undefined));
    if (values.some((v) => v !== values[0])) count++;
  }
  return count;
}

/**
 * Matches resources of one kind across N environments by identity. Two-pass: an
 * identical raw name shared by 2+ envs always wins as a match first (e.g. the same
 * literal deployment name sitting, unmodified, in both a "stage" and a "prod"
 * namespace) — only names that DON'T already have a same-raw match elsewhere fall
 * back to per-env label-stripped canonicalization. Without this ordering, stripping
 * one side's env-label token (but not the other's, since only one side's own label
 * matches that token) can split an exact-name match into two separate rows.
 */
export function matchAcrossEnvironments(
  inputs: EnvResourceInput[],
): Map<string, Map<string, Record<string, unknown>>> {
  const rawNameGroups = new Map<string, Map<string, Record<string, unknown>>>();
  const perEnvResources: { envId: string; label: string; name: string; resource: Record<string, unknown> }[] = [];

  for (const { envId, label, resources } of inputs) {
    for (const resource of resources) {
      const name = resourceName(resource);
      if (!name) continue;
      perEnvResources.push({ envId, label, name, resource });
      if (!rawNameGroups.has(name)) rawNameGroups.set(name, new Map());
      rawNameGroups.get(name)!.set(envId, resource);
    }
  }

  const byCanonical = new Map<string, Map<string, Record<string, unknown>>>();
  const claimedByExactMatch = new Set<string>();

  for (const [rawName, envMap] of rawNameGroups) {
    if (envMap.size >= 2) {
      byCanonical.set(rawName, envMap);
      for (const envId of envMap.keys()) claimedByExactMatch.add(`${envId}::${rawName}`);
    }
  }

  for (const { envId, label, name, resource } of perEnvResources) {
    if (claimedByExactMatch.has(`${envId}::${name}`)) continue;
    const canonical = canonicalName(name, label);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Map());
    const group = byCanonical.get(canonical)!;
    if (!group.has(envId)) group.set(envId, resource);
  }

  return byCanonical;
}

/** Matches resources of one kind across N environments, and scores how much each match differs. */
export function buildOverview(inputs: EnvResourceInput[]): OverviewRow[] {
  const byCanonical = matchAcrossEnvironments(inputs);
  const allEnvIds = inputs.map((i) => i.envId);
  const rows: OverviewRow[] = [];

  for (const [canonical, envMap] of byCanonical) {
    const namesByEnv: Record<string, string | null> = {};
    const presentEnvIds: string[] = [];
    for (const envId of allEnvIds) {
      const resource = envMap.get(envId);
      if (resource) {
        namesByEnv[envId] = resourceName(resource) ?? null;
        presentEnvIds.push(envId);
      } else {
        namesByEnv[envId] = null;
      }
    }
    const missingEnvIds = allEnvIds.filter((id) => !presentEnvIds.includes(id));

    let diffFieldCount: number | null = null;
    if (presentEnvIds.length >= 2) {
      diffFieldCount = countDifferingPaths(presentEnvIds.map((id) => flatten(envMap.get(id))));
    }

    rows.push({ canonicalName: canonical, namesByEnv, presentEnvIds, missingEnvIds, diffFieldCount });
  }

  return rows.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
}

export interface ImageVersionRow {
  deployment: string;
  container: string;
  isInit: boolean;
  images: Record<string, string | null>;
  differs: boolean;
}

function getContainersMap(
  resource: Record<string, unknown>,
  key: "containers" | "initContainers",
): Record<string, unknown> | undefined {
  const spec = resource.spec as Record<string, unknown> | undefined;
  const template = spec?.template as Record<string, unknown> | undefined;
  const podSpec = template?.spec as Record<string, unknown> | undefined;
  const containers = podSpec?.[key];
  return typeof containers === "object" && containers !== null && !Array.isArray(containers)
    ? (containers as Record<string, unknown>)
    : undefined;
}

function getContainerImage(
  resource: Record<string, unknown>,
  key: "containers" | "initContainers",
  name: string,
): string | null {
  const container = getContainersMap(resource, key)?.[name] as Record<string, unknown> | undefined;
  return typeof container?.image === "string" ? container.image : null;
}

/** Pulls the container image tag per environment for every matched deployment — the "image versions across envs" report. */
export function extractContainerImages(
  matched: Map<string, Map<string, Record<string, unknown>>>,
  envIds: string[],
): ImageVersionRow[] {
  const rows: ImageVersionRow[] = [];

  for (const [deploymentName, envMap] of matched) {
    const containerNames = new Map<string, boolean>();
    for (const resource of envMap.values()) {
      for (const name of Object.keys(getContainersMap(resource, "containers") ?? {})) {
        containerNames.set(name, false);
      }
      for (const name of Object.keys(getContainersMap(resource, "initContainers") ?? {})) {
        containerNames.set(name, true);
      }
    }

    for (const [containerName, isInit] of containerNames) {
      const key = isInit ? "initContainers" : "containers";
      const images: Record<string, string | null> = {};
      for (const envId of envIds) {
        const resource = envMap.get(envId);
        images[envId] = resource ? getContainerImage(resource, key, containerName) : null;
      }
      const presentEnvCount = envIds.filter((id) => envMap.has(id)).length;
      const presentImages = Object.values(images).filter((v): v is string => v !== null);
      const differs = new Set(presentImages).size > 1 || presentImages.length !== presentEnvCount;
      rows.push({ deployment: deploymentName, container: containerName, isInit, images, differs });
    }
  }

  return rows.sort(
    (a, b) => a.deployment.localeCompare(b.deployment) || a.container.localeCompare(b.container),
  );
}

export interface FieldCell {
  present: boolean;
  value: unknown;
}

/**
 * How a field differs across environments:
 * - `identical`  — set in every environment, same value everywhere
 * - `value`      — set in every environment, but the values disagree
 * - `presence`   — set in some environments and absent from others
 *
 * When a field is both absent somewhere AND has disagreeing values among the
 * environments that do have it, `presence` wins: a missing field is the more
 * structural finding, and it's what you usually want to act on first.
 */
export type DiffKind = "identical" | "value" | "presence";

export interface FieldMatrixRow {
  path: string;
  cells: Record<string, FieldCell>;
  differs: boolean;
  diffKind: DiffKind;
}

/** Pivots one matched resource's per-env normalized bodies into rows = field path, columns = env. */
export function buildFieldMatrix(
  resourcesByEnv: Record<string, Record<string, unknown> | undefined>,
): FieldMatrixRow[] {
  const envIds = Object.keys(resourcesByEnv);
  const flattenedByEnv: Record<string, Record<string, unknown>> = {};
  for (const envId of envIds) {
    const resource = resourcesByEnv[envId];
    flattenedByEnv[envId] = resource ? flatten(resource) : {};
  }

  const allPaths = new Set<string>();
  for (const envId of envIds) for (const path of Object.keys(flattenedByEnv[envId])) allPaths.add(path);

  const rows: FieldMatrixRow[] = [];
  for (const path of Array.from(allPaths).sort()) {
    const cells: Record<string, FieldCell> = {};
    const presentValues: string[] = [];
    for (const envId of envIds) {
      const present = path in flattenedByEnv[envId];
      cells[envId] = { present, value: present ? flattenedByEnv[envId][path] : undefined };
      if (present) presentValues.push(JSON.stringify(flattenedByEnv[envId][path]));
    }
    const missingSomewhere = presentValues.length !== envIds.length;
    const valuesDisagree = new Set(presentValues).size > 1;
    const diffKind: DiffKind = missingSomewhere ? "presence" : valuesDisagree ? "value" : "identical";
    rows.push({ path, cells, differs: diffKind !== "identical", diffKind });
  }
  return rows;
}
