import type {
  V1Container,
  V1Deployment,
  V1Ingress,
  V1LabelSelector,
  V1Volume,
} from "@kubernetes/client-node";
import type { NamespaceSnapshot } from "../k8s/fetch.js";

export interface ReferenceEdge {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount" | "PriorityClass";
  name: string;
  usage: string;
}

export interface ReverseEdge {
  kind: "Service" | "PodDisruptionBudget" | "HorizontalPodAutoscaler" | "Ingress";
  name: string;
  detail: string;
}

function walkContainers(containers: V1Container[] | undefined, edges: ReferenceEdge[]): void {
  for (const c of containers ?? []) {
    for (const env of c.env ?? []) {
      const cmRef = env.valueFrom?.configMapKeyRef;
      if (cmRef?.name) {
        edges.push({ kind: "ConfigMap", name: cmRef.name, usage: `env var ${env.name} in container ${c.name}` });
      }
      const secretRef = env.valueFrom?.secretKeyRef;
      if (secretRef?.name) {
        edges.push({ kind: "Secret", name: secretRef.name, usage: `env var ${env.name} in container ${c.name}` });
      }
    }
    for (const ef of c.envFrom ?? []) {
      if (ef.configMapRef?.name) {
        edges.push({ kind: "ConfigMap", name: ef.configMapRef.name, usage: `envFrom in container ${c.name}` });
      }
      if (ef.secretRef?.name) {
        edges.push({ kind: "Secret", name: ef.secretRef.name, usage: `envFrom in container ${c.name}` });
      }
    }
  }
}

function walkVolumes(volumes: V1Volume[] | undefined, edges: ReferenceEdge[]): void {
  for (const v of volumes ?? []) {
    if (v.configMap?.name) {
      edges.push({ kind: "ConfigMap", name: v.configMap.name, usage: `volume ${v.name}` });
    }
    if (v.secret?.secretName) {
      edges.push({ kind: "Secret", name: v.secret.secretName, usage: `volume ${v.name}` });
    }
    if (v.persistentVolumeClaim?.claimName) {
      edges.push({
        kind: "PersistentVolumeClaim",
        name: v.persistentVolumeClaim.claimName,
        usage: `volume ${v.name}`,
      });
    }
    for (const src of v.projected?.sources ?? []) {
      if (src.configMap?.name) {
        edges.push({ kind: "ConfigMap", name: src.configMap.name, usage: `projected volume ${v.name}` });
      }
      if (src.secret?.name) {
        edges.push({ kind: "Secret", name: src.secret.name, usage: `projected volume ${v.name}` });
      }
    }
  }
}

/** Walks a deployment's pod template for every name reference to a ConfigMap, Secret, PVC, ServiceAccount, or PriorityClass. */
export function resolveForwardReferences(deployment: V1Deployment): ReferenceEdge[] {
  const edges: ReferenceEdge[] = [];
  const podSpec = deployment.spec?.template?.spec;
  if (!podSpec) return edges;

  walkContainers(podSpec.containers, edges);
  walkContainers(podSpec.initContainers, edges);
  walkVolumes(podSpec.volumes, edges);

  for (const ref of podSpec.imagePullSecrets ?? []) {
    if (ref.name) edges.push({ kind: "Secret", name: ref.name, usage: "imagePullSecrets" });
  }
  if (podSpec.serviceAccountName) {
    edges.push({ kind: "ServiceAccount", name: podSpec.serviceAccountName, usage: "serviceAccountName" });
  }
  if (podSpec.priorityClassName) {
    edges.push({ kind: "PriorityClass", name: podSpec.priorityClassName, usage: "priorityClassName" });
  }
  return edges;
}

/** Service.spec.selector is a plain label-equality map, not a full V1LabelSelector. */
export function simpleSelectorMatches(
  selector: Record<string, string> | undefined,
  labels: Record<string, string>,
): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** Full k8s label-selector semantics (matchLabels + matchExpressions), used by PDBs/NetworkPolicies. */
export function selectorMatches(selector: V1LabelSelector | undefined, labels: Record<string, string>): boolean {
  if (!selector || (!selector.matchLabels && !selector.matchExpressions)) return false;

  if (selector.matchLabels) {
    for (const [k, v] of Object.entries(selector.matchLabels)) {
      if (labels[k] !== v) return false;
    }
  }

  for (const expr of selector.matchExpressions ?? []) {
    const value = labels[expr.key];
    switch (expr.operator) {
      case "In":
        if (value === undefined || !expr.values?.includes(value)) return false;
        break;
      case "NotIn":
        if (value !== undefined && expr.values?.includes(value)) return false;
        break;
      case "Exists":
        if (value === undefined) return false;
        break;
      case "DoesNotExist":
        if (value !== undefined) return false;
        break;
    }
  }
  return true;
}

function collectIngressBackendServiceNames(ingress: V1Ingress): string[] {
  const names: string[] = [];
  if (ingress.spec?.defaultBackend?.service?.name) {
    names.push(ingress.spec.defaultBackend.service.name);
  }
  for (const rule of ingress.spec?.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      if (path.backend.service?.name) names.push(path.backend.service.name);
    }
  }
  return names;
}

/** Finds Services/PDBs/HPAs/Ingresses that point back at this deployment, via selector or scaleTargetRef matching. */
export function resolveReverseReferences(
  deployment: V1Deployment,
  snapshot: Pick<NamespaceSnapshot, "services" | "pdbs" | "hpas" | "ingresses">,
): ReverseEdge[] {
  const podLabels = deployment.spec?.template?.metadata?.labels ?? {};
  const edges: ReverseEdge[] = [];
  const matchedServiceNames = new Set<string>();

  for (const svc of snapshot.services) {
    if (simpleSelectorMatches(svc.spec?.selector, podLabels)) {
      const name = svc.metadata?.name ?? "";
      edges.push({ kind: "Service", name, detail: "selector matches pod labels" });
      matchedServiceNames.add(name);
    }
  }

  for (const pdb of snapshot.pdbs) {
    if (selectorMatches(pdb.spec?.selector, podLabels)) {
      edges.push({ kind: "PodDisruptionBudget", name: pdb.metadata?.name ?? "", detail: "selector matches pod labels" });
    }
  }

  for (const hpa of snapshot.hpas) {
    if (hpa.spec?.scaleTargetRef.kind === "Deployment" && hpa.spec.scaleTargetRef.name === deployment.metadata?.name) {
      edges.push({ kind: "HorizontalPodAutoscaler", name: hpa.metadata?.name ?? "", detail: "scaleTargetRef" });
    }
  }

  for (const ing of snapshot.ingresses) {
    const backends = collectIngressBackendServiceNames(ing);
    const matchedBackend = backends.find((name) => matchedServiceNames.has(name));
    if (matchedBackend) {
      edges.push({ kind: "Ingress", name: ing.metadata?.name ?? "", detail: `routes to service ${matchedBackend}` });
    }
  }

  return edges;
}

/** ConfigMap/Secret/PVC forward refs that point at a name absent from the namespace. */
export function findDanglingReferences(
  edges: ReferenceEdge[],
  snapshot: Pick<NamespaceSnapshot, "configMaps" | "secrets" | "pvcs">,
): ReferenceEdge[] {
  const configMapNames = new Set(snapshot.configMaps.map((c) => c.metadata?.name));
  const secretNames = new Set(snapshot.secrets.map((s) => s.metadata?.name));
  const pvcNames = new Set(snapshot.pvcs.map((p) => p.metadata?.name));

  return edges.filter((e) => {
    if (e.kind === "ConfigMap") return !configMapNames.has(e.name);
    if (e.kind === "Secret") return !secretNames.has(e.name);
    if (e.kind === "PersistentVolumeClaim") return !pvcNames.has(e.name);
    return false;
  });
}
