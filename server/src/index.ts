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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.D8S_API_PORT ?? 4173);
const IS_DEV = process.env.NODE_ENV !== "production";

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

  const raw = await fetchNamespaceSnapshot(env.context, env.namespace);
  return raw.deployments.map((d) => d.metadata?.name).filter((n): n is string => Boolean(n));
});

app.get<{ Params: { id: string; name: string } }>(
  "/api/environments/:id/deployments/:name/bundle",
  async (req, reply) => {
    const envs = await loadEnvironments();
    const env = envs.find((e) => e.id === req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });

    const raw = await fetchNamespaceSnapshot(env.context, env.namespace);
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

async function fetchSnapshotsSettled(envs: Environment[]): Promise<EnvFetchResult[]> {
  const settled = await Promise.allSettled(
    envs.map((env) => getNormalizedSnapshot(env.context, env.namespace)),
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

  const results = await fetchSnapshotsSettled(envs);
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

    const results = await fetchSnapshotsSettled(envs);

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
await app.listen({ port: PORT });
if (IS_DEV) {
  app.log.info(`API dev server on ${url} — run the web dev server separately`);
} else {
  app.log.info(`D8s running at ${url}`);
  await open(url);
}
