import { KubeConfig, type ApiConstructor, type ApiType } from "@kubernetes/client-node";

/**
 * Cached KubeConfig instances, keyed by context name.
 *
 * This matters more than it looks. client-node creates its ExecAuth (and the
 * token cache inside it) per KubeConfig instance, so building a fresh KubeConfig
 * for every request throws that cache away and re-runs the kubeconfig's exec
 * credential plugin — `aws eks get-token`, `kubelogin`, etc. Each of those is a
 * subprocess plus a network round-trip to the cloud provider.
 *
 * Worse, ExecAuth has no in-flight de-duplication: concurrent requests that all
 * miss an empty cache each spawn their own subprocess. Fetching 10 resource
 * kinds in parallel therefore meant up to 10 simultaneous `aws eks get-token`
 * calls per environment, per request.
 *
 * Reusing the KubeConfig keeps that token cache warm, so the plugin runs roughly
 * once per token lifetime instead. client-node still refreshes the token itself
 * when it expires, so this is purely about not discarding the cache.
 *
 * The TTL exists only so edits to your kubeconfig get picked up without a
 * restart; it is not needed for token freshness.
 */
const CONFIG_TTL_MS = 5 * 60 * 1000;

interface CachedConfig {
  kc: KubeConfig;
  loadedAt: number;
}

const cache = new Map<string, CachedConfig>();

export function kubeConfigFor(contextName: string): KubeConfig {
  const hit = cache.get(contextName);
  if (hit && Date.now() - hit.loadedAt < CONFIG_TTL_MS) return hit.kc;

  const kc = new KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(contextName);
  cache.set(contextName, { kc, loadedAt: Date.now() });
  return kc;
}

export function apiClientFor<T extends ApiType>(
  contextName: string,
  apiClientType: ApiConstructor<T>,
): T {
  return kubeConfigFor(contextName).makeApiClient(apiClientType);
}

/** Drop cached configs — used when the set of environments/contexts changes. */
export function clearKubeConfigCache(): void {
  cache.clear();
}
