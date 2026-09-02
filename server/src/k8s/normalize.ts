/**
 * Strips fields the cluster/API server injects that are never meaningful in a
 * cross-environment diff (status, bookkeeping metadata, admission-controller
 * defaults), and re-keys array fields that are logically maps (containers, env
 * vars, volumes, ports) by their name instead of position, so reordering never
 * shows up as a spurious diff.
 */

const METADATA_NOISE_KEYS = new Set([
  "managedFields",
  "resourceVersion",
  "uid",
  "creationTimestamp",
  "generation",
  "selfLink",
  "ownerReferences",
]);

const NOISE_ANNOTATIONS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
  "kubectl.kubernetes.io/restartedAt",
]);

// Positional arrays that are logically keyed collections — re-key by `name`.
const NAME_KEYED_ARRAY_PATHS = new Set([
  "spec.template.spec.containers",
  "spec.template.spec.initContainers",
  "spec.containers",
  "spec.initContainers",
]);

const CONTAINER_SUB_ARRAY_KEYS = new Set(["env", "ports", "volumeMounts", "envFrom"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripMetadata(metadata: any): any {
  if (!isPlainObject(metadata)) return metadata;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (METADATA_NOISE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Drop noisy annotation keys. Applied wherever an `annotations` map appears in the
 * tree (top-level metadata, pod template metadata, etc.) — not just at the root,
 * since e.g. `restartedAt` lives on spec.template.metadata.annotations. */
function filterAnnotations(annotations: Record<string, unknown>): Record<string, unknown> | undefined {
  const kept = Object.fromEntries(
    Object.entries(annotations).filter(([k]) => !NOISE_ANNOTATIONS.has(k)),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function keyArrayByName(arr: unknown[]): Record<string, unknown> | unknown[] {
  if (arr.length === 0) return arr;
  if (!arr.every((item) => isPlainObject(item) && typeof item.name === "string")) {
    return arr;
  }
  const out: Record<string, unknown> = {};
  for (const item of arr as Record<string, unknown>[]) {
    out[item.name as string] = normalizeContainerLike(item);
  }
  return out;
}

function normalizeContainerLike(container: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(container)) {
    if (CONTAINER_SUB_ARRAY_KEYS.has(k) && Array.isArray(v)) {
      out[k] = keyArrayByName(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function walkAndReKeyArrays(node: unknown, path: string): unknown {
  if (Array.isArray(node)) {
    if (NAME_KEYED_ARRAY_PATHS.has(path)) {
      return keyArrayByName(node);
    }
    return node.map((item, i) => walkAndReKeyArrays(item, `${path}[${i}]`));
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "annotations" && isPlainObject(v)) {
        const filtered = filterAnnotations(v);
        if (filtered !== undefined) out.annotations = filtered;
        continue;
      }
      out[k] = walkAndReKeyArrays(v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return node;
}

/** Normalize a raw k8s object for comparison: strip status, strip noisy metadata, re-key arrays. */
export function normalizeResource<T extends { metadata?: any; status?: any }>(
  resource: T,
): Record<string, unknown> {
  const { status, metadata, ...rest } = resource as any;
  const normalized: Record<string, unknown> = {
    ...rest,
    metadata: stripMetadata(metadata),
  };
  return walkAndReKeyArrays(normalized, "") as Record<string, unknown>;
}

/** Flatten a normalized object into dot/bracket path -> primitive value pairs, for the diff matrix. */
export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isPlainObject(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      out[prefix] = obj;
      return out;
    }
    for (const key of keys) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flatten((obj as Record<string, unknown>)[key], nextPrefix, out);
    }
    return out;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      out[prefix] = obj;
      return out;
    }
    obj.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  out[prefix] = obj;
  return out;
}
