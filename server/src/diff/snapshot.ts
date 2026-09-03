import { fetchNamespaceSnapshot } from "../k8s/fetch.js";
import { normalizeResource } from "../k8s/normalize.js";
import { hashSecretData } from "./secrets.js";

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

export type NormalizedSnapshot = Record<ResourceKind, Record<string, unknown>[]>;

export async function getNormalizedSnapshot(
  context: string,
  namespace: string,
  kinds: readonly ResourceKind[] = RESOURCE_KINDS,
): Promise<NormalizedSnapshot> {
  const raw = await fetchNamespaceSnapshot(context, namespace, kinds);
  return {
    deployments: raw.deployments.map(normalizeResource),
    statefulSets: raw.statefulSets.map(normalizeResource),
    daemonSets: raw.daemonSets.map(normalizeResource),
    configMaps: raw.configMaps.map(normalizeResource),
    secrets: raw.secrets.map(hashSecretData).map(normalizeResource),
    services: raw.services.map(normalizeResource),
    pvcs: raw.pvcs.map(normalizeResource),
    ingresses: raw.ingresses.map(normalizeResource),
    pdbs: raw.pdbs.map(normalizeResource),
    hpas: raw.hpas.map(normalizeResource),
  };
}
