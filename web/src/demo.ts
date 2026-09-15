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
  ChartInfo,
  ContextInfo,
  DeploymentBundle,
  Environment,
  FieldCell,
  FieldMatrixRow,
  HelmCompareResponse,
  IgnoreRule,
  ImageVersionsResponse,
  OverviewResponse,
  ResourceCompareResponse,
  ResourceDifferences,
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

/** Pretend the demo data was fetched a few minutes ago, until "refreshed". */
let demoFetchedAt = Date.now() - 4 * 60 * 1000;

function envStatuses(ids: string[]) {
  return ids.map((id) => {
    const env = environments.find((e) => e.id === id);
    return { id, label: env?.label ?? id, status: "ok" as const, fetchedAt: demoFetchedAt };
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

function baseOverview(ids: string[]): OverviewResponse {
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
          missingFieldCount: 3,
          valuePaths: null,
          missingPaths: null,
        },
        {
          canonicalName: "checkout-api",
          namesByEnv: { [a]: null, [b]: "checkout-api" },
          presentEnvIds: [b],
          missingEnvIds: [a],
          diffFieldCount: null,
          missingFieldCount: null,
          valuePaths: null,
          missingPaths: null,
        },
        {
          canonicalName: "worker-cron",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "worker-cron"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 0,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
      ],
      configMaps: [
        {
          canonicalName: "kube-root-ca.crt",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "kube-root-ca.crt"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 1,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
        {
          canonicalName: "payments-config",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-config"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 6,
          missingFieldCount: 2,
          valuePaths: null,
          missingPaths: null,
        },
      ],
      services: [
        {
          canonicalName: "payments-api-svc",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-api-svc"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 2,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
      ],
    },
  };
}

function cell(value: unknown): FieldCell {
  return { present: true, value };
}
const absent: FieldCell = { present: false, value: undefined };

/** Mirrors buildFieldMatrix() in server/src/diff/engine.ts so demo rows classify
 *  exactly the way real ones do. */
function row(path: string, cells: Record<string, FieldCell>): FieldMatrixRow {
  const all = Object.values(cells);
  const presentValues = all.filter((c) => c.present).map((c) => JSON.stringify(c.value));
  const missingSomewhere = presentValues.length !== all.length;
  const valuesDisagree = new Set(presentValues).size > 1;
  const diffKind = missingSomewhere ? "presence" : valuesDisagree ? "value" : "identical";
  return { path, cells, diffKind, differs: diffKind !== "identical" };
}

/**
 * Fills each overview row's counts and paths from the rows its drill-down
 * returns, so the demo's pills, drill-downs and ignore rules always agree.
 */
function attachPaths<T extends { kinds: Record<string, OverviewResponse["kinds"][ResourceKind]> }>(
  response: T,
  rowsFor: (canonicalName: string) => FieldMatrixRow[],
): T {
  for (const rows of Object.values(response.kinds)) {
    for (const row of rows) {
      if (row.diffFieldCount === null) continue;
      const fields = rowsFor(row.canonicalName);
      row.valuePaths = fields.filter((f) => f.diffKind === "value").map((f) => f.path);
      row.missingPaths = fields.filter((f) => f.diffKind === "presence").map((f) => f.path);
      row.diffFieldCount = row.valuePaths.length + row.missingPaths.length;
      row.missingFieldCount = row.missingPaths.length;
    }
  }
  return response;
}

function buildOverview(ids: string[]): OverviewResponse {
  return attachPaths(baseOverview(ids), (name) => buildResourceCompare(ids, name).rows);
}

function buildResourceCompare(ids: string[], canonicalName: string): ResourceCompareResponse {
  const [a, b] = [ids[0], ids[1] ?? ids[0]];
  const container = `${canonicalName}-container`;
  const p = `spec.template.spec.containers.${container}`;

  const rows =
    canonicalName === "payments-api"
      ? [
          row("metadata.name", { [a]: cell("payments-api"), [b]: cell("payments-api") }),
          row("metadata.namespace", { [a]: cell("payments-dev"), [b]: cell("payments-prod") }),
          row("spec.replicas", { [a]: cell(1), [b]: cell(3) }),
          row(`${p}.image`, {
            [a]: cell("registry.example.com/payments-api:a1b2c3d"),
            [b]: cell("registry.example.com/payments-api:f9e8d7c"),
          }),
          row(`${p}.env.DB_HOST.valueFrom.secretKeyRef.name`, {
            [a]: cell("payments-db-secret-dev"),
            [b]: absent,
          }),
          row(`${p}.resources.limits.cpu`, { [a]: absent, [b]: cell("500m") }),
          row(`${p}.resources.limits.memory`, { [a]: absent, [b]: cell("512Mi") }),
          row(`${p}.livenessProbe.initialDelaySeconds`, { [a]: cell(5), [b]: cell(30) }),
          row(`${p}.livenessProbe.periodSeconds`, { [a]: cell(10), [b]: cell(10) }),
          row(`${p}.imagePullPolicy`, { [a]: cell("IfNotPresent"), [b]: cell("IfNotPresent") }),
        ]
      : canonicalName === "payments-config"
        ? [
            row("metadata.name", { [a]: cell("payments-config"), [b]: cell("payments-config") }),
            row("data.LOG_LEVEL", { [a]: cell("debug"), [b]: cell("warn") }),
            row("data.FEATURE_NEW_CHECKOUT", { [a]: cell("true"), [b]: cell("false") }),
            row("data.PAYMENT_TIMEOUT_MS", { [a]: cell("30000"), [b]: cell("10000") }),
            row("data.application.yaml", {
              [a]: cell(
                "server:\n  port: 8080\n  shutdown: graceful\nspring:\n  datasource:\n    url: jdbc:postgresql://payments-db.payments-dev.svc.cluster.local:5432/payments?sslmode=disable&connectTimeout=10&socketTimeout=30&applicationName=payments-api\n    hikari:\n      maximum-pool-size: 5",
              ),
              [b]: cell(
                "server:\n  port: 8080\n  shutdown: graceful\nspring:\n  datasource:\n    url: jdbc:postgresql://payments-db.payments-prod.svc.cluster.local:5432/payments?sslmode=require&connectTimeout=5&socketTimeout=15&applicationName=payments-api\n    hikari:\n      maximum-pool-size: 40",
              ),
            }),
            row("data.SENTRY_DSN", { [a]: absent, [b]: cell("https://public@sentry.example.com/42") }),
            row("data.DEBUG_TOOLBAR", { [a]: cell("enabled"), [b]: absent }),
          ]
        : canonicalName === "kube-root-ca.crt"
          ? [
              row("metadata.name", { [a]: cell("kube-root-ca.crt"), [b]: cell("kube-root-ca.crt") }),
              row("data.ca.crt", {
                [a]: cell("-----BEGIN CERTIFICATE-----\nMIIC/jCCAeagAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJlcm5ldGVzMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowFTETMBEGA1UEAxMKa3ViZXJuZXRlczCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMdevA\n-----END CERTIFICATE-----"),
                [b]: cell("-----BEGIN CERTIFICATE-----\nMIIC/jCCAeagAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJlcm5ldGVzMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowFTETMBEGA1UEAxMKa3ViZXJuZXRlczCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMprodB\n-----END CERTIFICATE-----"),
              }),
            ]
          : canonicalName === "payments-api-svc"
            ? [
                row("metadata.name", { [a]: cell("payments-api-svc"), [b]: cell("payments-api-svc") }),
                row("spec.type", { [a]: cell("ClusterIP"), [b]: cell("LoadBalancer") }),
                row("metadata.annotations.service.beta.kubernetes.io/aws-load-balancer-type", {
                  [a]: absent,
                  [b]: cell("nlb"),
                }),
              ]
            : [
                row("metadata.name", { [a]: cell(canonicalName), [b]: cell(canonicalName) }),
                row("spec.replicas", { [a]: cell(1), [b]: cell(1) }),
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

const DEMO_CHART: ChartInfo = {
  path: "/Users/you/charts/payments",
  name: "payments",
  version: "1.4.2",
  appVersion: "2.1.0",
  description: "Payments service chart",
  valuesFiles: ["values.yaml", "values/dev.yaml", "values/prod.yaml"],
};

/** Chart rendered with prod values vs. the live prod namespace: the chart wants 3
 *  replicas and a newer image than what is actually deployed. */
function helmResourceRows(live: string, canonicalName: string): FieldMatrixRow[] {
  if (canonicalName === "payments-api") {
    return [
      row("metadata.name", { chart: cell("payments-api"), [live]: cell("payments-api") }),
      // The chart wants 3 replicas and a newer image than what is deployed.
      row("spec.replicas", { chart: cell(3), [live]: cell(2) }),
      row("spec.template.spec.containers.api.image", {
        chart: cell("registry.example.com/payments-api:1.4.2"),
        [live]: cell("registry.example.com/payments-api:1.3.9"),
      }),
      row("spec.template.spec.containers.api.resources.limits.cpu", {
        chart: cell("500m"),
        [live]: cell("500m"),
      }),
    ];
  }
  if (canonicalName === "payments-config") {
    return [
      row("metadata.name", { chart: cell("payments-config"), [live]: cell("payments-config") }),
      row("data.LOG_LEVEL", { chart: cell("info"), [live]: cell("warn") }),
    ];
  }
  return [row("metadata.name", { chart: cell(canonicalName), [live]: cell(canonicalName) })];
}

function buildHelmCompare(environmentId: string): HelmCompareResponse {
  return attachPaths(baseHelmCompare(environmentId), (name) => helmResourceRows(environmentId, name));
}

function baseHelmCompare(environmentId: string): HelmCompareResponse {
  const envLabel = environments.find((e) => e.id === environmentId)?.label ?? "prod";
  const envs = [
    { id: "chart", label: "chart: payments", status: "ok" as const },
    { id: environmentId, label: envLabel, status: "ok" as const },
  ];
  const both = ["chart", environmentId];
  return {
    chart: { name: "payments", version: "1.4.2", path: DEMO_CHART.path },
    valuesFiles: ["values.yaml", "values/prod.yaml"],
    envs,
    kinds: {
      ...emptyKinds(),
      deployments: [
        {
          canonicalName: "payments-api",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-api"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 2,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
        {
          canonicalName: "payments-worker",
          namesByEnv: { chart: "payments-worker", [environmentId]: null },
          presentEnvIds: ["chart"],
          missingEnvIds: [environmentId],
          diffFieldCount: null,
          missingFieldCount: null,
          valuePaths: null,
          missingPaths: null,
        },
      ],
      services: [
        {
          canonicalName: "payments-api-svc",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-api-svc"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 0,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
      ],
      configMaps: [
        {
          canonicalName: "payments-config",
          namesByEnv: Object.fromEntries(both.map((id) => [id, "payments-config"])),
          presentEnvIds: both,
          missingEnvIds: [],
          diffFieldCount: 1,
          missingFieldCount: 0,
          valuePaths: null,
          missingPaths: null,
        },
      ],
    },
  };
}

/** The export endpoints return the overview plus every differing field of every
 *  matched resource; here that means replaying the per-resource builders. */
function buildDifferences(
  kinds: Record<string, { canonicalName: string }[]>,
  rowsFor: (canonicalName: string) => FieldMatrixRow[],
) {
  const out: ResourceDifferences[] = [];
  for (const [kind, rows] of Object.entries(kinds)) {
    for (const r of rows) {
      const differing = rowsFor(r.canonicalName).filter((f) => f.differs);
      if (differing.length > 0) {
        out.push({ kind: kind as ResourceKind, resource: r.canonicalName, rows: differing });
      }
    }
  }
  return out;
}

const IGNORES_KEY = "d8s-demo-ignores";

function loadDemoIgnores(): IgnoreRule[] {
  try {
    return JSON.parse(localStorage.getItem(IGNORES_KEY) ?? "[]") as IgnoreRule[];
  } catch {
    return [];
  }
}

let demoIgnores: IgnoreRule[] = loadDemoIgnores();

function saveDemoIgnores() {
  try {
    localStorage.setItem(IGNORES_KEY, JSON.stringify(demoIgnores));
  } catch {
    // Storage blocked: rules still work for this page load.
  }
}

export const demoApi = {
  listIgnores: () => delay([...demoIgnores], 100),
  addIgnore: (input: { kind: string; resource: string | null; path: string | null }) => {
    const existing = demoIgnores.find(
      (r) => r.kind === input.kind && r.resource === input.resource && r.path === input.path,
    );
    if (existing) return delay(existing, 100);
    const rule: IgnoreRule = { id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ...input, createdAt: Date.now() };
    demoIgnores = [...demoIgnores, rule];
    saveDemoIgnores();
    return delay(rule, 100);
  },
  removeIgnore: (id: string) => {
    demoIgnores = demoIgnores.filter((r) => r.id !== id);
    saveDemoIgnores();
    return delay(undefined as void, 100);
  },
  clearIgnores: () => {
    demoIgnores = [];
    saveDemoIgnores();
    return delay(undefined as void, 100);
  },
  refreshCache: (_environmentIds: string[]) => {
    demoFetchedAt = Date.now();
    return delay(undefined as void, 200);
  },
  helmCheck: () => delay({ available: true, version: "v4.1.1" }, 150),
  helmInspect: (_chartPath: string) => delay(DEMO_CHART, 300),
  helmLint: (_chartPath: string, _valuesFiles: string[]) =>
    delay(
      {
        ok: true,
        messages: [
          { severity: "unknown" as const, text: "==> Linting /Users/you/charts/payments" },
          { severity: "info" as const, text: "Chart.yaml: icon is recommended" },
          { severity: "unknown" as const, text: "1 chart(s) linted, 0 chart(s) failed" },
        ],
        raw: "",
      },
      400,
    ),
  helmCompare: (body: { environmentId: string }) => delay(buildHelmCompare(body.environmentId), 700),
  helmCompareResource: (body: { environmentId: string; canonicalName: string }) => {
    const envs = [
      { id: "chart", label: "chart: payments", status: "ok" as const },
      {
        id: body.environmentId,
        label: environments.find((e) => e.id === body.environmentId)?.label ?? "prod",
        status: "ok" as const,
      },
    ];
    const live = body.environmentId;
    const rows = helmResourceRows(live, body.canonicalName);
    return delay({ envs, rows, resources: { chart: {}, [live]: {} } }, 400);
  },
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
  compareExport: (environmentIds: string[]) => {
    const overview = buildOverview(environmentIds);
    return delay(
      {
        ...overview,
        differences: buildDifferences(
          overview.kinds,
          (name) => buildResourceCompare(environmentIds, name).rows,
        ),
      },
      700,
    );
  },
  helmCompareExport: (body: { environmentId: string }) => {
    const compare = buildHelmCompare(body.environmentId);
    return delay(
      {
        ...compare,
        differences: buildDifferences(compare.kinds, (name) => helmResourceRows(body.environmentId, name)),
      },
      800,
    );
  },
};
