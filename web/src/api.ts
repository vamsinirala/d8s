export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  isCurrent: boolean;
}

export interface Environment {
  id: string;
  label: string;
  context: string;
  namespace: string;
}

export const RESOURCE_KINDS = [
  "deployments",
  "statefulSets",
  "daemonSets",
  "configMaps",
  "secrets",
  "services",
  "pvcs",
  "ingresses",
  "pdbs",
  "hpas",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface CompareEnvStatus {
  id: string;
  label: string;
  status: "ok" | "error";
  error?: string;
  /** Epoch ms the cluster data was fetched; absent for rendered chart output. */
  fetchedAt?: number;
}

export interface OverviewRow {
  canonicalName: string;
  namesByEnv: Record<string, string | null>;
  presentEnvIds: string[];
  missingEnvIds: string[];
  diffFieldCount: number | null;
  /** Of diffFieldCount, paths set in some environments but absent from others. */
  missingFieldCount: number | null;
  /** The paths behind the counts, so ignore rules can be applied client-side. */
  valuePaths: string[] | null;
  missingPaths: string[] | null;
}

/** A reviewed difference to hide. resource null = every resource of the kind;
 *  path null = the whole resource; a path also covers everything beneath it. */
export interface IgnoreRule {
  id: string;
  kind: string;
  resource: string | null;
  path: string | null;
  createdAt: number;
}

export interface OverviewResponse {
  envs: CompareEnvStatus[];
  kinds: Record<ResourceKind, OverviewRow[]>;
}

export interface FieldCell {
  present: boolean;
  value: unknown;
}

/** identical = same everywhere; value = set everywhere but values disagree;
 *  presence = set in some environments and absent from others. */
export type DiffKind = "identical" | "value" | "presence";

export interface FieldMatrixRow {
  path: string;
  cells: Record<string, FieldCell>;
  differs: boolean;
  diffKind: DiffKind;
}

export interface ResourceCompareResponse {
  envs: CompareEnvStatus[];
  rows: FieldMatrixRow[];
  resources: Record<string, Record<string, unknown> | null>;
}

export interface ReferenceEdge {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount" | "PriorityClass";
  name: string;
  usage: string;
}

export interface ReverseEdge {
  kind: "Service" | "PodDisruptionBudget" | "HorizontalPodAutoscaler" | "Ingress";
  name: string;
  detail: string;
}

export interface DeploymentBundle {
  deployment: string;
  forward: ReferenceEdge[];
  reverse: ReverseEdge[];
  dangling: ReferenceEdge[];
}

export interface ImageVersionRow {
  deployment: string;
  container: string;
  isInit: boolean;
  images: Record<string, string | null>;
  differs: boolean;
}

export interface ImageVersionsResponse {
  envs: CompareEnvStatus[];
  rows: ImageVersionRow[];
}

/** Every differing field of one matched resource, as returned by the export endpoints. */
export interface ResourceDifferences {
  kind: ResourceKind;
  resource: string;
  rows: FieldMatrixRow[];
}

export interface CompareExportResponse extends OverviewResponse {
  differences: ResourceDifferences[];
}

export interface HelmExportResponse extends HelmCompareResponse {
  differences: ResourceDifferences[];
}

export interface HelmAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export interface ChartInfo {
  path: string;
  name: string;
  version?: string;
  appVersion?: string;
  description?: string;
  valuesFiles: string[];
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

export interface HelmCompareInput {
  chartPath: string;
  valuesFiles: string[];
  environmentId: string;
  releaseName?: string;
  ignoreServerDefaults: boolean;
}

/** Same shape as OverviewResponse, plus which chart produced it. */
export interface HelmCompareResponse extends OverviewResponse {
  chart: { name: string; version?: string; path: string };
  valuesFiles: string[];
}

import { IS_DEMO, demoApi } from "./demo";
import { cachedResponse, clearResponseCache } from "./responseCache";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

const realApi = {
  listContexts: () => fetch("/api/contexts").then((r) => json<ContextInfo[]>(r)),
  listNamespaces: (context: string) =>
    fetch(`/api/contexts/${encodeURIComponent(context)}/namespaces`).then((r) =>
      json<string[]>(r),
    ),
  listEnvironments: () => fetch("/api/environments").then((r) => json<Environment[]>(r)),
  addEnvironment: (env: { label: string; context: string; namespace: string }) =>
    fetch("/api/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    }).then((r) => json<Environment>(r)),
  removeEnvironment: (id: string) =>
    fetch(`/api/environments/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),
  compareOverview: (environmentIds: string[]) =>
    cachedResponse(`overview:${environmentIds.join(",")}`, () => fetch("/api/compare/overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    }).then((r) => json<OverviewResponse>(r))),
  compareResource: (environmentIds: string[], kind: ResourceKind, canonicalName: string) =>
    cachedResponse(`resource:${environmentIds.join(",")}:${kind}:${canonicalName}`, () => fetch("/api/compare/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds, kind, canonicalName }),
    }).then((r) => json<ResourceCompareResponse>(r))),
  listDeployments: (envId: string) =>
    fetch(`/api/environments/${envId}/deployments`).then((r) => json<string[]>(r)),
  getBundle: (envId: string, deploymentName: string) =>
    fetch(`/api/environments/${envId}/deployments/${encodeURIComponent(deploymentName)}/bundle`).then((r) =>
      json<DeploymentBundle>(r),
    ),
  compareImages: (environmentIds: string[]) =>
    cachedResponse(`images:${environmentIds.join(",")}`, () => fetch("/api/compare/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    }).then((r) => json<ImageVersionsResponse>(r))),
  /** Discards cached data in both the browser and the server for these environments. */
  refreshCache: async (environmentIds: string[]) => {
    await clearResponseCache();
    const r = await fetch("/api/cache/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  },
  listIgnores: () => fetch("/api/ignores").then((r) => json<IgnoreRule[]>(r)),
  addIgnore: (rule: { kind: string; resource: string | null; path: string | null }) =>
    fetch("/api/ignores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rule),
    }).then((r) => json<IgnoreRule>(r)),
  removeIgnore: (id: string) =>
    fetch(`/api/ignores/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),
  clearIgnores: () =>
    fetch("/api/ignores", { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    }),
  helmCheck: () => fetch("/api/helm/check").then((r) => json<HelmAvailability>(r)),
  helmInspect: (chartPath: string) =>
    fetch("/api/helm/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chartPath }),
    }).then((r) => json<ChartInfo>(r)),
  helmLint: (chartPath: string, valuesFiles: string[]) =>
    fetch("/api/helm/lint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chartPath, valuesFiles }),
    }).then((r) => json<LintResult>(r)),
  helmCompare: (body: HelmCompareInput) =>
    fetch("/api/helm/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<HelmCompareResponse>(r)),
  compareExport: (environmentIds: string[]) =>
    fetch("/api/compare/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    }).then((r) => json<CompareExportResponse>(r)),
  helmCompareExport: (body: HelmCompareInput) =>
    fetch("/api/helm/compare/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<HelmExportResponse>(r)),
  helmCompareResource: (body: HelmCompareInput & { kind: ResourceKind; canonicalName: string }) =>
    fetch("/api/helm/compare/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<ResourceCompareResponse>(r)),
};

/** In the GitHub Pages demo build, swap the whole API surface for in-memory data. */
export const api = IS_DEMO ? demoApi : realApi;
