import { normalizeResource } from "../k8s/normalize.js";
import { RESOURCE_KINDS, type NormalizedSnapshot, type ResourceKind } from "../diff/snapshot.js";
import { hashSecretData } from "../diff/secrets.js";

/** Kubernetes `kind` -> the snapshot bucket the diff engine uses. */
const KIND_TO_BUCKET: Record<string, ResourceKind> = {
  Deployment: "deployments",
  StatefulSet: "statefulSets",
  DaemonSet: "daemonSets",
  ConfigMap: "configMaps",
  Secret: "secrets",
  Service: "services",
  PersistentVolumeClaim: "pvcs",
  Ingress: "ingresses",
  PodDisruptionBudget: "pdbs",
  HorizontalPodAutoscaler: "hpas",
};

function emptySnapshot(): NormalizedSnapshot {
  const out = {} as NormalizedSnapshot;
  for (const kind of RESOURCE_KINDS) out[kind] = [];
  return out;
}

/** Turns `helm template` output into the same normalized shape as a live namespace. */
export function snapshotFromManifests(manifests: Record<string, unknown>[]): NormalizedSnapshot {
  const snapshot = emptySnapshot();
  for (const doc of manifests) {
    const kind = typeof doc.kind === "string" ? doc.kind : undefined;
    if (!kind) continue;
    const bucket = KIND_TO_BUCKET[kind];
    if (!bucket) continue;
    const prepared = bucket === "secrets" ? hashSecretData(doc as never) : doc;
    snapshot[bucket].push(normalizeResource(prepared as never));
  }
  return snapshot;
}

/**
 * Field paths the API server fills in when you don't specify them.
 *
 * A rendered chart never contains these, so without special handling every
 * comparison drowns in "missing from chart" rows that say nothing about drift.
 *
 * Matched as path segments so they apply at any depth (containers, initContainers,
 * each volume, and so on).
 */
const SERVER_DEFAULTED = [
  /(^|\.)creationTimestamp$/,
  // `helm template` does not stamp the namespace into rendered manifests unless
  // the chart does it explicitly, while every live object carries one — so this
  // would otherwise differ on every single resource, every time.
  /^metadata\.namespace$/,
  /(^|\.)terminationMessagePath$/,
  /(^|\.)terminationMessagePolicy$/,
  /(^|\.)dnsPolicy$/,
  /(^|\.)restartPolicy$/,
  /(^|\.)schedulerName$/,
  /(^|\.)securityContext$/,
  /(^|\.)terminationGracePeriodSeconds$/,
  /(^|\.)revisionHistoryLimit$/,
  /(^|\.)progressDeadlineSeconds$/,
  /(^|\.)strategy\./,
  /(^|\.)imagePullPolicy$/,
  /(^|\.)protocol$/,
  /(^|\.)clusterIP$/,
  /(^|\.)clusterIPs$/,
  /(^|\.)ipFamilies$/,
  /(^|\.)ipFamilyPolicy$/,
  /(^|\.)internalTrafficPolicy$/,
  /(^|\.)externalTrafficPolicy$/,
  /(^|\.)sessionAffinity$/,
  /(^|\.)targetPort$/,
  /(^|\.)defaultMode$/,
  /(^|\.)serviceAccount$/,
  /(^|\.)successThreshold$/,
  /(^|\.)failureThreshold$/,
  /(^|\.)periodSeconds$/,
  /(^|\.)timeoutSeconds$/,
  /(^|\.)scheme$/,
  /(^|\.)deprecatedTopologyKeys$/,
  /(^|\.)status(\.|$)/,
  /(^|\.)metadata\.(uid|generation|resourceVersion|selfLink)$/,
  /(^|\.)finalizers(\.|\[|$)/,
];

function isServerDefaulted(path: string): boolean {
  return SERVER_DEFAULTED.some((re) => re.test(path));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Removes server-populated fields from the live resource *only where the chart
 * is silent about them*.
 *
 * This is deliberately asymmetric. If the chart does set a field, it stays on
 * both sides and any disagreement is reported — that is a genuine drift. It is
 * only the "cluster filled this in because nobody said otherwise" case that gets
 * suppressed.
 */
export function stripDefaultsNotInChart(live: unknown, chart: unknown, path = ""): unknown {
  // Arrays need walking too: things like container ports carry their own
  // defaulted fields (protocol: TCP), and skipping arrays would leak those.
  // Elements are paired by index, which is what the normalizer's name-keying
  // leaves us with for genuinely positional lists.
  if (Array.isArray(live)) {
    const chartArr = Array.isArray(chart) ? chart : [];
    return live.map((item, i) => stripDefaultsNotInChart(item, chartArr[i], `${path}[${i}]`));
  }

  if (!isPlainObject(live)) return live;
  const chartObj = isPlainObject(chart) ? chart : undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    const childPath = path ? `${path}.${key}` : key;
    const chartHasKey = chartObj !== undefined && key in chartObj;

    if (!chartHasKey && isServerDefaulted(childPath)) continue;

    if (Array.isArray(value)) {
      out[key] = stripDefaultsNotInChart(value, chartObj?.[key], childPath);
    } else if (isPlainObject(value)) {
      const cleaned = stripDefaultsNotInChart(value, chartObj?.[key], childPath) as Record<
        string,
        unknown
      >;
      // If everything inside was a server default and the chart never mentions
      // this key, drop the now-empty container too. Otherwise it resurfaces as a
      // phantom "missing from chart" row for a field nobody wrote.
      if (!chartHasKey && Object.keys(cleaned).length === 0 && Object.keys(value).length > 0) {
        continue;
      }
      out[key] = cleaned;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resourceName(r: Record<string, unknown>): string | undefined {
  const meta = r.metadata as Record<string, unknown> | undefined;
  return typeof meta?.name === "string" ? meta.name : undefined;
}

/**
 * Applies the default-stripping to a whole live snapshot, pairing each live
 * resource with its same-named counterpart in the rendered chart.
 */
export function reconcileLiveWithChart(
  live: NormalizedSnapshot,
  chart: NormalizedSnapshot,
): NormalizedSnapshot {
  const out = emptySnapshot();
  for (const kind of RESOURCE_KINDS) {
    const chartByName = new Map(
      chart[kind].map((r) => [resourceName(r), r] as const).filter(([n]) => n !== undefined),
    );
    out[kind] = live[kind].map((r) => {
      const counterpart = chartByName.get(resourceName(r));
      // No counterpart in the chart: leave it untouched, it is reported as
      // "only in the cluster", which is exactly right.
      if (!counterpart) return r;
      return stripDefaultsNotInChart(r, counterpart) as Record<string, unknown>;
    });
  }
  return out;
}
