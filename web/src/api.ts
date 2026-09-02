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
}

export interface OverviewRow {
  canonicalName: string;
  namesByEnv: Record<string, string | null>;
  presentEnvIds: string[];
  missingEnvIds: string[];
  diffFieldCount: number | null;
}

export interface OverviewResponse {
  envs: CompareEnvStatus[];
  kinds: Record<ResourceKind, OverviewRow[]>;
}

export interface FieldCell {
  present: boolean;
  value: unknown;
}

export interface FieldMatrixRow {
  path: string;
  cells: Record<string, FieldCell>;
  differs: boolean;
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
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
    fetch("/api/compare/overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    }).then((r) => json<OverviewResponse>(r)),
  compareResource: (environmentIds: string[], kind: ResourceKind, canonicalName: string) =>
    fetch("/api/compare/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds, kind, canonicalName }),
    }).then((r) => json<ResourceCompareResponse>(r)),
  listDeployments: (envId: string) =>
    fetch(`/api/environments/${envId}/deployments`).then((r) => json<string[]>(r)),
  getBundle: (envId: string, deploymentName: string) =>
    fetch(`/api/environments/${envId}/deployments/${encodeURIComponent(deploymentName)}/bundle`).then((r) =>
      json<DeploymentBundle>(r),
    ),
  compareImages: (environmentIds: string[]) =>
    fetch("/api/compare/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentIds }),
    }).then((r) => json<ImageVersionsResponse>(r)),
};
