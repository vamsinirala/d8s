/**
 * In-memory cache of namespace listings, one entry per (context, namespace, kind).
 *
 * Every view — overview, drill-down, image versions, export, Helm — reads the
 * same namespaces, and before this each click re-listed them from the cluster
 * (and re-authenticated). Caching per kind fits the selective fetching in
 * fetch.ts: a drill-down into ConfigMaps reuses the ConfigMaps an earlier
 * overview already listed.
 *
 * Deliberately memory-only: cluster data is never written to disk, and a
 * restart starts clean.
 *
 * Staleness is the real risk for a drift tool, so every response carries the
 * time its data was fetched and the UI shows it next to a Refresh button.
 */

const TTL_MS = Math.max(0, Number(process.env.D8S_CACHE_TTL_SECONDS ?? 300)) * 1000;

interface Entry<T> {
  /** Shared by concurrent callers, so simultaneous requests make one API call. */
  promise: Promise<T>;
  fetchedAt: number;
}

const entries = new Map<string, Entry<unknown>>();

function key(context: string, namespace: string, kind: string): string {
  // NUL can't appear in a context name, namespace or kind.
  return `${context}\0${namespace}\0${kind}`;
}

/**
 * Returns the cached listing if fresh, otherwise fetches it. A failed fetch is
 * evicted rather than cached, so an expired token or a network blip doesn't
 * stick around for the whole TTL.
 */
export function cached<T>(
  context: string,
  namespace: string,
  kind: string,
  fetch: () => Promise<T>,
): { promise: Promise<T>; fetchedAt: number } {
  const k = key(context, namespace, kind);
  const now = Date.now();
  const hit = entries.get(k) as Entry<T> | undefined;
  if (hit && TTL_MS > 0 && now - hit.fetchedAt < TTL_MS) return hit;

  const entry: Entry<T> = { promise: fetch(), fetchedAt: now };
  if (TTL_MS > 0) {
    entries.set(k, entry);
    entry.promise.catch(() => {
      if (entries.get(k) === entry) entries.delete(k);
    });
  }
  return entry;
}

/** Drops every cached kind for a namespace, so the next read hits the cluster. */
export function invalidate(context: string, namespace: string): void {
  const prefix = `${context}\0${namespace}\0`;
  for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
}
