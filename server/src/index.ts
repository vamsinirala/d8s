import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import open from "open";
import { listContexts, listNamespaces } from "./k8s/contexts.js";
import {
  addEnvironment,
  loadEnvironments,
  removeEnvironment,
  type Environment,
} from "./config/store.js";
import { getNormalizedSnapshot, RESOURCE_KINDS, type ResourceKind } from "./diff/snapshot.js";
import {
  buildOverview,
  buildFieldMatrix,
  canonicalName,
  matchAcrossEnvironments,
  extractContainerImages,
  type OverviewRow,
} from "./diff/engine.js";
import { fetchNamespaceSnapshot } from "./k8s/fetch.js";
import {
  resolveForwardReferences,
  resolveReverseReferences,
  findDanglingReferences,
} from "./graph/resolve.js";
import { checkHelm, inspectChart, lintChart, renderChart } from "./helm/helm.js";
import { snapshotFromManifests, reconcileLiveWithChart } from "./helm/snapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.D8S_API_PORT ?? 4173);
// Production mode serves the built UI and opens the browser. Enabled by
// NODE_ENV=production (release launchers) or --production (npm start), the flag
// existing because inline env vars in npm scripts don't work on Windows.
const IS_DEV = process.env.NODE_ENV !== "production" && !process.argv.includes("--production");

const app = Fastify({ logger: true });

app.get("/api/contexts", async () => {
  return listContexts();
});

app.get<{ Params: { name: string } }>(
  "/api/contexts/:name/namespaces",
  async (req) => {
    return listNamespaces(req.params.name);
  },
);

app.get("/api/environments", async () => {
  return loadEnvironments();
});

app.post<{ Body: { label: string; context: string; namespace: string } }>(
  "/api/environments",
  async (req, reply) => {
    const { label, context, namespace } = req.body;
    if (!label || !context || !namespace) {
      return reply.code(400).send({ error: "label, context, namespace are required" });
    }
    return addEnvironment({ label, context, namespace });
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/environments/:id",
  async (req, reply) => {
    await removeEnvironment(req.params.id);
    return reply.code(204).send();
  },
);

app.get<{ Params: { id: string } }>(
  "/api/environments/:id/snapshot",
  async (req, reply) => {
    const envs = await loadEnvironments();
    const env = envs.find((e) => e.id === req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });

    const snapshot = await getNormalizedSnapshot(env.context, env.namespace);
    return {
      counts: Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, snapshot[kind].length])),
      ...snapshot,
    };
  },
);

app.get<{ Params: { id: string } }>("/api/environments/:id/deployments", async (req, reply) => {
  const envs = await loadEnvironments();
  const env = envs.find((e) => e.id === req.params.id);
  if (!env) return reply.code(404).send({ error: "environment not found" });

  const raw = await fetchNamespaceSnapshot(env.context, env.namespace, ["deployments"]);
  return raw.deployments.map((d) => d.metadata?.name).filter((n): n is string => Boolean(n));
});

app.get<{ Params: { id: string; name: string } }>(
  "/api/environments/:id/deployments/:name/bundle",
  async (req, reply) => {
    const envs = await loadEnvironments();
    const env = envs.find((e) => e.id === req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });

    // The bundle needs the deployment itself, the kinds it can reference
    // (for dangling detection) and the kinds that can reference it back.
    // StatefulSets and DaemonSets play no part, so skip them.
    const raw = await fetchNamespaceSnapshot(env.context, env.namespace, [
      "deployments", "configMaps", "secrets", "pvcs", "services", "ingresses", "pdbs", "hpas",
    ]);
    const deployment = raw.deployments.find((d) => d.metadata?.name === req.params.name);
    if (!deployment) return reply.code(404).send({ error: "deployment not found" });

    const forward = resolveForwardReferences(deployment);
    const reverse = resolveReverseReferences(deployment, raw);
    const dangling = findDanglingReferences(forward, raw);

    return { deployment: req.params.name, forward, reverse, dangling };
  },
);

async function resolveEnvironments(
  environmentIds: string[],
  reply: import("fastify").FastifyReply,
): Promise<Environment[] | undefined> {
  if (!environmentIds || environmentIds.length === 0) {
    reply.code(400).send({ error: "environmentIds required" });
    return undefined;
  }
  const allEnvs = await loadEnvironments();
  const envs = environmentIds.map((id) => allEnvs.find((e) => e.id === id));
  const missingIndex = envs.findIndex((e) => !e);
  if (missingIndex !== -1) {
    reply.code(400).send({ error: `environment not found: ${environmentIds[missingIndex]}` });
    return undefined;
  }
  return envs as Environment[];
}

interface EnvFetchResult {
  env: Environment;
  status: "ok" | "error";
  snapshot?: Awaited<ReturnType<typeof getNormalizedSnapshot>>;
  error?: string;
}

/** Fetches each environment's snapshot, limited to the kinds the caller needs. */
async function fetchSnapshotsSettled(
  envs: Environment[],
  kinds: readonly ResourceKind[] = RESOURCE_KINDS,
): Promise<EnvFetchResult[]> {
  const settled = await Promise.allSettled(
    envs.map((env) => getNormalizedSnapshot(env.context, env.namespace, kinds)),
  );
  return settled.map((result, i) => {
    const env = envs[i];
    if (result.status === "fulfilled") {
      return { env, status: "ok" as const, snapshot: result.value };
    }
    return { env, status: "error" as const, error: String(result.reason?.message ?? result.reason) };
  });
}

app.post<{ Body: { environmentIds: string[] } }>("/api/compare/overview", async (req, reply) => {
  const envs = await resolveEnvironments(req.body?.environmentIds, reply);
  if (!envs) return;

  const results = await fetchSnapshotsSettled(envs);
  const ok = results.filter((r) => r.status === "ok");

  const kinds: Record<ResourceKind, OverviewRow[]> = {} as Record<ResourceKind, OverviewRow[]>;
  for (const kind of RESOURCE_KINDS) {
    kinds[kind] = buildOverview(
      ok.map((r) => ({ envId: r.env.id, label: r.env.label, resources: r.snapshot![kind] })),
    );
  }

  return {
    envs: results.map((r) => ({
      id: r.env.id,
      label: r.env.label,
      status: r.status,
      error: r.error,
    })),
    kinds,
  };
});

app.post<{ Body: { environmentIds: string[] } }>("/api/compare/images", async (req, reply) => {
  const envs = await resolveEnvironments(req.body?.environmentIds, reply);
  if (!envs) return;

  // Only deployments are needed for the image-version report.
  const results = await fetchSnapshotsSettled(envs, ["deployments"]);
  const ok = results.filter((r) => r.status === "ok");

  const matched = matchAcrossEnvironments(
    ok.map((r) => ({ envId: r.env.id, label: r.env.label, resources: r.snapshot!.deployments })),
  );
  const rows = extractContainerImages(matched, ok.map((r) => r.env.id));

  return {
    envs: results.map((r) => ({
      id: r.env.id,
      label: r.env.label,
      status: r.status,
      error: r.error,
    })),
    rows,
  };
});

app.post<{ Body: { environmentIds: string[]; kind: ResourceKind; canonicalName: string } }>(
  "/api/compare/resource",
  async (req, reply) => {
    const { kind, canonicalName: targetCanonical } = req.body;
    if (!RESOURCE_KINDS.includes(kind)) {
      return reply.code(400).send({ error: `invalid kind: ${kind}` });
    }
    const envs = await resolveEnvironments(req.body?.environmentIds, reply);
    if (!envs) return;

    // Drilling into one resource only needs that resource's kind.
    const results = await fetchSnapshotsSettled(envs, [kind]);

    const resourcesByEnv: Record<string, Record<string, unknown> | undefined> = {};
    for (const r of results) {
      if (r.status !== "ok") continue;
      resourcesByEnv[r.env.id] = r.snapshot![kind].find((resource) => {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name;
        return typeof name === "string" && canonicalName(name, r.env.label) === targetCanonical;
      });
    }

    return {
      envs: results.map((r) => ({
        id: r.env.id,
        label: r.env.label,
        status: r.status,
        error: r.error,
      })),
      rows: buildFieldMatrix(resourcesByEnv),
      resources: Object.fromEntries(envs.map((e) => [e.id, resourcesByEnv[e.id] ?? null])),
    };
  },
);

interface HelmCompareInput {
  chartPath: string;
  valuesFiles?: string[];
  environmentId: string;
  releaseName?: string;
  ignoreServerDefaults?: boolean;
}

/**
 * Shared setup for both Helm comparison endpoints: render the chart, read the
 * live namespace, and optionally strip cluster-populated defaults the chart
 * never mentions. Rendering is fast and local, so re-doing it for a drill-down
 * is cheaper than caching rendered output and risking staleness.
 */
async function prepareHelmComparison(body: HelmCompareInput) {
  const { chartPath, valuesFiles = [], environmentId, releaseName, ignoreServerDefaults = true } = body;

  const allEnvs = await loadEnvironments();
  const env = allEnvs.find((e) => e.id === environmentId);
  if (!env) throw Object.assign(new Error(`environment not found: ${environmentId}`), { status: 400 });

  const chart = await inspectChart(chartPath);

  const [renderResult, liveResult] = await Promise.allSettled([
    renderChart(chart.path, valuesFiles, releaseName?.trim() || chart.name, env.namespace),
    getNormalizedSnapshot(env.context, env.namespace),
  ]);

  if (renderResult.status === "rejected") {
    throw Object.assign(new Error(String(renderResult.reason?.message ?? renderResult.reason)), {
      status: 400,
    });
  }

  const chartSnapshot = snapshotFromManifests(renderResult.value);
  const liveSnapshot =
    liveResult.status === "fulfilled"
      ? ignoreServerDefaults
        ? reconcileLiveWithChart(liveResult.value, chartSnapshot)
        : liveResult.value
      : null;

  const envs = [
    { id: "chart", label: `chart: ${chart.name}`, status: "ok" as const },
    {
      id: env.id,
      label: env.label,
      status: liveSnapshot ? ("ok" as const) : ("error" as const),
      error:
        liveResult.status === "rejected"
          ? String(liveResult.reason?.message ?? liveResult.reason)
          : undefined,
    },
  ];

  return { chart, env, chartSnapshot, liveSnapshot, envs };
}

app.get("/api/helm/check", async () => checkHelm());

app.post<{ Body: { chartPath: string } }>("/api/helm/inspect", async (req, reply) => {
  const { chartPath } = req.body ?? {};
  if (!chartPath?.trim()) return reply.code(400).send({ error: "chartPath is required" });
  try {
    return await inspectChart(chartPath);
  } catch (e: any) {
    return reply.code(400).send({ error: String(e?.message ?? e) });
  }
});

app.post<{ Body: { chartPath: string; valuesFiles?: string[] } }>(
  "/api/helm/lint",
  async (req, reply) => {
    const { chartPath, valuesFiles = [] } = req.body ?? {};
    if (!chartPath?.trim()) return reply.code(400).send({ error: "chartPath is required" });
    try {
      const chart = await inspectChart(chartPath);
      return await lintChart(chart.path, valuesFiles);
    } catch (e: any) {
      return reply.code(400).send({ error: String(e?.message ?? e) });
    }
  },
);

app.post<{ Body: HelmCompareInput }>("/api/helm/compare", async (req, reply) => {
  const body = req.body ?? ({} as HelmCompareInput);
  if (!body.chartPath?.trim()) return reply.code(400).send({ error: "chartPath is required" });
  if (!body.environmentId) return reply.code(400).send({ error: "environmentId is required" });

  try {
    const { chart, env, chartSnapshot, liveSnapshot, envs } = await prepareHelmComparison(body);

    const kinds: Record<ResourceKind, OverviewRow[]> = {} as Record<ResourceKind, OverviewRow[]>;
    for (const kind of RESOURCE_KINDS) {
      const inputs = [{ envId: "chart", label: "chart", resources: chartSnapshot[kind] }];
      if (liveSnapshot) {
        inputs.push({ envId: env.id, label: env.label, resources: liveSnapshot[kind] });
      }
      kinds[kind] = buildOverview(inputs);
    }

    return {
      chart: { name: chart.name, version: chart.version, path: chart.path },
      valuesFiles: body.valuesFiles ?? [],
      envs,
      kinds,
    };
  } catch (e: any) {
    return reply.code(e?.status ?? 400).send({ error: String(e?.message ?? e) });
  }
});

/** Field-level drill-down for one resource in a chart-vs-cluster comparison. */
app.post<{ Body: HelmCompareInput & { kind: ResourceKind; canonicalName: string } }>(
  "/api/helm/compare/resource",
  async (req, reply) => {
    const body = req.body ?? ({} as never);
    const { kind, canonicalName: target } = body;
    if (!RESOURCE_KINDS.includes(kind)) {
      return reply.code(400).send({ error: `invalid kind: ${kind}` });
    }

    try {
      const { env, chartSnapshot, liveSnapshot, envs } = await prepareHelmComparison(body);

      const pick = (resources: Record<string, unknown>[], label: string) =>
        resources.find((r) => {
          const name = (r.metadata as Record<string, unknown> | undefined)?.name;
          return typeof name === "string" && canonicalName(name, label) === target;
        });

      const resourcesByEnv: Record<string, Record<string, unknown> | undefined> = {
        chart: pick(chartSnapshot[kind], "chart"),
      };
      if (liveSnapshot) resourcesByEnv[env.id] = pick(liveSnapshot[kind], env.label);

      return { envs, rows: buildFieldMatrix(resourcesByEnv), resources: resourcesByEnv };
    } catch (e: any) {
      return reply.code(e?.status ?? 400).send({ error: String(e?.message ?? e) });
    }
  },
);

if (!IS_DEV) {
  const webDist = join(__dirname, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }
}

const url = `http://localhost:${PORT}`;
// Bind to loopback explicitly. D8s reads your kubeconfig, talks to your clusters
// and (for the Helm view) reads local chart directories, so it must never be
// reachable from the network. Fastify already defaults to localhost; stating it
// here makes the guarantee deliberate rather than incidental.
await app.listen({ port: PORT, host: "127.0.0.1" });
if (IS_DEV) {
  app.log.info(`API dev server on ${url} — run the web dev server separately`);
} else {
  app.log.info(`D8s running at ${url}`);
  await open(url);
}
