import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";
import { apiClientFor } from "./clients.js";

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  isCurrent: boolean;
}

export function listContexts(): ContextInfo[] {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const current = kc.getCurrentContext();
  return kc.getContexts().map((ctx) => ({
    name: ctx.name,
    cluster: ctx.cluster,
    user: ctx.user,
    namespace: ctx.namespace,
    isCurrent: ctx.name === current,
  }));
}

function coreApiForContext(contextName: string): CoreV1Api {
  return apiClientFor(contextName, CoreV1Api);
}

export async function listNamespaces(contextName: string): Promise<string[]> {
  const api = coreApiForContext(contextName);
  const res = await api.listNamespace();
  return res.items
    .map((ns) => ns.metadata?.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

export { apiClientFor } from "./clients.js";
