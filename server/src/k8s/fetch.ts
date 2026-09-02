import {
  KubeConfig,
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

function clientsFor(contextName: string) {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  kc.setCurrentContext(contextName);
  return {
    apps: kc.makeApiClient(AppsV1Api),
    core: kc.makeApiClient(CoreV1Api),
    networking: kc.makeApiClient(NetworkingV1Api),
    policy: kc.makeApiClient(PolicyV1Api),
    autoscaling: kc.makeApiClient(AutoscalingV2Api),
  };
}

export async function fetchNamespaceSnapshot(
  contextName: string,
  namespace: string,
): Promise<NamespaceSnapshot> {
  const { apps, core, networking, policy, autoscaling } = clientsFor(contextName);

  const [
    deploymentList,
    statefulSetList,
    daemonSetList,
    configMapList,
    secretList,
    serviceList,
    pvcList,
    ingressList,
    pdbList,
    hpaList,
  ] = await Promise.all([
    apps.listNamespacedDeployment({ namespace }),
    apps.listNamespacedStatefulSet({ namespace }),
    apps.listNamespacedDaemonSet({ namespace }),
    core.listNamespacedConfigMap({ namespace }),
    core.listNamespacedSecret({ namespace }),
    core.listNamespacedService({ namespace }),
    core.listNamespacedPersistentVolumeClaim({ namespace }),
    networking.listNamespacedIngress({ namespace }),
    policy.listNamespacedPodDisruptionBudget({ namespace }),
    autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace }),
  ]);

  return {
    deployments: deploymentList.items,
    statefulSets: statefulSetList.items,
    daemonSets: daemonSetList.items,
    configMaps: configMapList.items,
    secrets: secretList.items,
    services: serviceList.items,
    pvcs: pvcList.items,
    ingresses: ingressList.items,
    pdbs: pdbList.items,
    hpas: hpaList.items,
  };
}
