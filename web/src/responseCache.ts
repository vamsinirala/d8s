/**
 * Browser-side cache of comparison responses, in IndexedDB.
 *
 * The server already caches cluster listings in memory (server/src/k8s/cache.ts),
 * which is what makes clicking around fast. This layer adds persistence: reload
 * the page, or come back tomorrow, and the last comparison opens instantly with
 * its age shown, until you press Refresh.
 *
 * Trade-off worth knowing: entries are written to the browser profile on disk.
 * Secret values are already hashed server-side, but ConfigMap data, env vars and
 * specs are stored as-is — hence the expiry and the "Clear cached data" control.
 *
 * Every operation fails soft: if IndexedDB is unavailable (private windows,
 * blocked site data) calls simply go to the network.
 */

const DB_NAME = "d8s";
const STORE = "responses";
/** Bump when a cached response shape changes; older entries are then ignored. */
const SCHEMA = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Stored {
  schema: number;
  savedAt: number;
  data: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Don't memoize a failure; a later call may succeed.
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * Serves `key` from IndexedDB when a fresh entry exists, otherwise calls
 * `fetcher` and stores the result.
 */
export async function cachedResponse<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const hit = await run<Stored | undefined>("readonly", (s) => s.get(key));
    if (hit && hit.schema === SCHEMA && Date.now() - hit.savedAt < MAX_AGE_MS) {
      return hit.data as T;
    }
  } catch {
    // Fall through to the network.
  }

  const data = await fetcher();
  const entry: Stored = { schema: SCHEMA, savedAt: Date.now(), data };
  run("readwrite", (s) => s.put(entry, key)).catch(() => {});
  return data;
}

/** Removes every cached response. */
export async function clearResponseCache(): Promise<void> {
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    // Nothing cached, or storage unavailable — either way there's nothing to clear.
  }
}
