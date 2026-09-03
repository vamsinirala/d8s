import {
  AppsV1Api,
  CoreV1Api,
  NetworkingV1Api,
  PolicyV1Api,
  AutoscalingV2Api,
  type V1Deployment,
  type V1StatefulSet,
  type V1DaemonSet,
  type V1ConfigMap,
  type V1Secret,
  type V1Service,
  type V1PersistentVolumeClaim,
  type V1Ingress,
  type V1PodDisruptionBudget,
  type V2HorizontalPodAutoscaler,
} from "@kubernetes/client-node";
import { apiClientFor } from "./clients.js";

export interface NamespaceSnapshot {
  deployments: V1Deployment[];
  statefulSets: V1StatefulSet[];
  daemonSets: V1DaemonSet[];
  configMaps: V1ConfigMap[];
  secrets: V1Secret[];
  services: V1Service[];
  pvcs: V1PersistentVolumeClaim[];
  ingresses: V1Ingress[];
  pdbs: V1PodDisruptionBudget[];
  hpas: V2HorizontalPodAutoscaler[];
}

export const RESOURCE_KINDS = [
  "deployments",
  "statefulSets",
  "daemonSets",
  "configMaps",
  "secrets",
  "services",
  "pvcs",
  "ingresses",
  "pdbs",
  "hpas",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

function clientsFor(contextName: string) {
  return {
    apps: apiClientFor(contextName, AppsV1Api),
    core: apiClientFor(contextName, CoreV1Api),
    networking: apiClientFor(contextName, NetworkingV1Api),
    policy: apiClientFor(contextName, PolicyV1Api),
    autoscaling: apiClientFor(contextName, AutoscalingV2Api),
  };
}

/**
 * Fetches the requested resource kinds from one namespace, concurrently.
 *
 * Callers pass only the kinds they actually use: the image-version report needs
 * deployments alone, and a single-resource drill-down needs one kind. Fetching
 * all ten regardless meant nine wasted API round-trips per environment, each of
 * which also had to authenticate.
 *
 * Kinds that aren't requested come back as empty arrays, so the shape of the
 * result is stable and callers don't have to handle undefined.
 */
export async function fetchNamespaceSnapshot(
  contextName: string,
  namespace: string,
  kinds: readonly ResourceKind[] = RESOURCE_KINDS,
): Promise<NamespaceSnapshot> {
  const wanted = new Set(kinds);
  const { apps, core, networking, policy, autoscaling } = clientsFor(contextName);

  const snapshot: NamespaceSnapshot = {
    deployments: [], statefulSets: [], daemonSets: [], configMaps: [], secrets: [],
    services: [], pvcs: [], ingresses: [], pdbs: [], hpas: [],
  };

  const fetchers: Record<ResourceKind, () => Promise<void>> = {
    deployments: async () => { snapshot.deployments = (await apps.listNamespacedDeployment({ namespace })).items; },
    statefulSets: async () => { snapshot.statefulSets = (await apps.listNamespacedStatefulSet({ namespace })).items; },
    daemonSets: async () => { snapshot.daemonSets = (await apps.listNamespacedDaemonSet({ namespace })).items; },
    configMaps: async () => { snapshot.configMaps = (await core.listNamespacedConfigMap({ namespace })).items; },
    secrets: async () => { snapshot.secrets = (await core.listNamespacedSecret({ namespace })).items; },
    services: async () => { snapshot.services = (await core.listNamespacedService({ namespace })).items; },
    pvcs: async () => { snapshot.pvcs = (await core.listNamespacedPersistentVolumeClaim({ namespace })).items; },
    ingresses: async () => { snapshot.ingresses = (await networking.listNamespacedIngress({ namespace })).items; },
    pdbs: async () => { snapshot.pdbs = (await policy.listNamespacedPodDisruptionBudget({ namespace })).items; },
    hpas: async () => { snapshot.hpas = (await autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace })).items; },
  };

  await Promise.all(RESOURCE_KINDS.filter((k) => wanted.has(k)).map((k) => fetchers[k]()));
  return snapshot;
}
