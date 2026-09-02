/**
 * Demo mode: a fully in-memory stand-in for the D8s API, used by the GitHub Pages
 * build so people can click through the real UI without installing anything or
 * pointing it at a cluster.
 *
 * Enabled at build time with VITE_DEMO=true. In a normal build the flag is
 * statically false, so this module's branch is dead code and gets tree-shaken out.
 *
 * All data below is fictional.
 */
import type {
  ContextInfo,
  DeploymentBundle,
  Environment,
  ImageVersionsResponse,
  OverviewResponse,
  ResourceCompareResponse,
  ResourceKind,
} from "./api";

export const IS_DEMO = import.meta.env.VITE_DEMO === "true";

const DEMO_CONTEXT = "arn:aws:eks:us-west-2:123456789012:cluster/example-cluster";

const CONTEXTS: ContextInfo[] = [
  { name: DEMO_CONTEXT, cluster: "example-cluster", user: "example-user", isCurrent: true },
  {
    name: "arn:aws:eks:eu-central-1:123456789012:cluster/example-cluster-eu",
    cluster: "example-cluster-eu",
    user: "example-user",
    isCurrent: false,
  },
];

const NAMESPACES = [
  "default",
  "kube-system",
  "payments-dev",
  "payments-stage",
  "payments-prod",
  "checkout-prod",
];

let environments: Environment[] = [
  { id: "e1", label: "dev", context: DEMO_CONTEXT, namespace: "payments-dev" },
  { id: "e2", label: "prod", context: DEMO_CONTEXT, namespace: "payments-prod" },
];

const DEPLOYMENTS = ["payments-api", "checkout-api", "worker-cron"];

function envStatuses(ids: string[]) {
  return ids.map((id) => {
    const env = environments.find((e) => e.id === id);
    return { id, label: env?.label ?? id, status: "ok" as const };
  });
}

/** Small delay so loading states are visible, like a real cluster round-trip. */
function delay<T>(value: T, ms = 350): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function emptyKinds(): Record<ResourceKind, never[]> {
  return {
    deployments: [],
    statefulSets: [],
    daemonSets: [],
    configMaps: [],
    secrets: [],
    services: [],
    pvcs: [],
    ingresses: [],
    pdbs: [],
    hpas: [],
  };
}

function buildOverview(ids: string[]): OverviewResponse {
  const [a, b] = [ids[0], ids[1] ?? ids[0]];
  const both = Array.from(new Set([a, b]));

  return {
    envs: envStatuses(ids),
    kinds: {
      ...emptyKinds(),
      deployments: [
        {
          canonicalName: "payments-api",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-api"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 42,
        },
        {
          canonicalName: "checkout-api",
          namesByEnv: { [a]: null, [b]: "checkout-api" },
          presentEnvIds: [b],
          missingEnvIds: [a],
          diffFieldCount: null,
        },
        {
          canonicalName: "worker-cron",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "worker-cron"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 0,
        },
      ],
      configMaps: [
        {
          canonicalName: "kube-root-ca.crt",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "kube-root-ca.crt"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 1,
        },
        {
          canonicalName: "payments-config",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-config"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 6,
        },
      ],
      services: [
        {
          canonicalName: "payments-api-svc",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-api-svc"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 2,
        },
      ],
    },
  };
}

function cell(value: unknown) {
  return { present: true, value };
}
const absent = { present: false, value: undefined };

function buildResourceCompare(ids: string[], canonicalName: string): ResourceCompareResponse {
  const [a, b] = [ids[0], ids[1] ?? ids[0]];
  const container = `${canonicalName}-container`;
  const p = `spec.template.spec.containers.${container}`;

  const rows =
    canonicalName === "payments-api"
      ? [
          { path: "metadata.name", cells: { [a]: cell("payments-api"), [b]: cell("payments-api") }, differs: false },
          {
            path: "metadata.namespace",
            cells: { [a]: cell("payments-dev"), [b]: cell("payments-prod") },
            differs: true,
          },
          { path: "spec.replicas", cells: { [a]: cell(1), [b]: cell(3) }, differs: true },
          {
            path: `${p}.image`,
            cells: {
              [a]: cell("registry.example.com/payments-api:a1b2c3d"),
              [b]: cell("registry.example.com/payments-api:f9e8d7c"),
            },
            differs: true,
          },
          {
            path: `${p}.env.DB_HOST.valueFrom.secretKeyRef.name`,
            cells: { [a]: cell("payments-db-secret-dev"), [b]: absent },
            differs: true,
          },
          {
            path: `${p}.resources.limits.cpu`,
            cells: { [a]: absent, [b]: cell("500m") },
            differs: true,
          },
          {
            path: `${p}.resources.limits.memory`,
            cells: { [a]: absent, [b]: cell("512Mi") },
            differs: true,
          },
          {
            path: `${p}.livenessProbe.initialDelaySeconds`,
            cells: { [a]: cell(5), [b]: cell(30) },
            differs: true,
          },
          {
            path: `${p}.imagePullPolicy`,
            cells: { [a]: cell("IfNotPresent"), [b]: cell("IfNotPresent") },
            differs: false,
          },
        ]
      : [
          { path: "metadata.name", cells: { [a]: cell(canonicalName), [b]: cell(canonicalName) }, differs: false },
          { path: "spec.replicas", cells: { [a]: cell(1), [b]: cell(1) }, differs: false },
        ];

  return {
    envs: envStatuses(ids),
    rows,
    resources: {
      [a]: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: canonicalName, namespace: "payments-dev" },
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: {
                [container]: {
                  image: "registry.example.com/payments-api:a1b2c3d",
                  livenessProbe: { initialDelaySeconds: 5 },
                },
              },
            },
          },
        },
      },
      [b]: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: canonicalName, namespace: "payments-prod" },
        spec: {
          replicas: 3,
          template: {
            spec: {
              containers: {
                [container]: {
                  image: "registry.example.com/payments-api:f9e8d7c",
                  livenessProbe: { initialDelaySeconds: 30 },
                  resources: { limits: { cpu: "500m", memory: "512Mi" } },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildImages(ids: string[]): ImageVersionsResponse {
  const [a, b] = [ids[0], ids[1] ?? ids[0]];
  return {
    envs: envStatuses(ids),
    rows: [
      {
        deployment: "payments-api",
        container: "payments-api-container",
        isInit: false,
        images: {
          [a]: "registry.example.com/payments-api:a1b2c3d",
          [b]: "registry.example.com/payments-api:f9e8d7c",
        },
        differs: true,
      },
      {
        deployment: "checkout-api",
        container: "checkout-api-container",
        isInit: false,
        images: { [a]: null, [b]: "registry.example.com/checkout-api:7c6b5a4" },
        differs: false,
      },
      {
        deployment: "worker-cron",
        container: "worker-cron-container",
        isInit: false,
        images: {
          [a]: "registry.example.com/worker-cron:c3d2e1f",
          [b]: "registry.example.com/worker-cron:c3d2e1f",
        },
        differs: false,
      },
    ],
  };
}

function buildBundle(deployment: string): DeploymentBundle {
  if (deployment !== "payments-api") {
    return {
      deployment,
      forward: [{ kind: "ConfigMap", name: `${deployment}-config`, usage: `envFrom in container ${deployment}-container` }],
      reverse: [{ kind: "Service", name: `${deployment}-svc`, detail: "selector matches pod labels" }],
      dangling: [],
    };
  }
  return {
    deployment: "payments-api",
    forward: [
      { kind: "ConfigMap", name: "payments-config", usage: "envFrom in container payments-api-container" },
      { kind: "Secret", name: "payments-db-secret", usage: "envFrom in container payments-api-container" },
      { kind: "Secret", name: "registry-credentials", usage: "imagePullSecrets" },
      { kind: "ServiceAccount", name: "payments-sa", usage: "serviceAccountName" },
      { kind: "ConfigMap", name: "legacy-feature-flags", usage: "volume config-vol" },
    ],
    reverse: [
      { kind: "Service", name: "payments-api-svc", detail: "selector matches pod labels" },
      { kind: "Ingress", name: "payments-ingress", detail: "routes to service payments-api-svc" },
      { kind: "HorizontalPodAutoscaler", name: "payments-api-hpa", detail: "scaleTargetRef" },
    ],
    dangling: [{ kind: "ConfigMap", name: "legacy-feature-flags", usage: "volume config-vol" }],
  };
}

export const demoApi = {
  listContexts: () => delay(CONTEXTS, 150),
  listNamespaces: (_context: string) => delay(NAMESPACES),
  listEnvironments: () => delay([...environments], 150),
  addEnvironment: (env: { label: string; context: string; namespace: string }) => {
    const created: Environment = { id: `e${Date.now()}`, ...env };
    environments = [...environments, created];
    return delay(created, 200);
  },
  removeEnvironment: (id: string) => {
    environments = environments.filter((e) => e.id !== id);
    return delay(undefined as void, 150);
  },
  compareOverview: (environmentIds: string[]) => delay(buildOverview(environmentIds), 500),
  compareResource: (environmentIds: string[], _kind: ResourceKind, canonicalName: string) =>
    delay(buildResourceCompare(environmentIds, canonicalName), 400),
  listDeployments: (_envId: string) => delay(DEPLOYMENTS, 250),
  getBundle: (_envId: string, deploymentName: string) => delay(buildBundle(deploymentName), 400),
  compareImages: (environmentIds: string[]) => delay(buildImages(environmentIds), 450),
};
