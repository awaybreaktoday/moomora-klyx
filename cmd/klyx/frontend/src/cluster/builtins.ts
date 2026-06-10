import { ResourceRef } from "../store/fleet";

export type BuiltinCategory = { label: string; kinds: ResourceRef[] };

export const BUILTIN_CATALOG: BuiltinCategory[] = [
  {
    label: "Workloads",
    kinds: [
      { group: "batch", version: "v1", plural: "jobs",     kind: "Job",      scope: "Namespaced" },
      { group: "batch", version: "v1", plural: "cronjobs", kind: "CronJob",  scope: "Namespaced" },
      { group: "apps",  version: "v1", plural: "replicasets", kind: "ReplicaSet", scope: "Namespaced" },
    ],
  },
  {
    label: "Config",
    kinds: [
      { group: "", version: "v1", plural: "configmaps", kind: "ConfigMap", scope: "Namespaced" },
      { group: "", version: "v1", plural: "secrets",    kind: "Secret",    scope: "Namespaced" },
    ],
  },
  {
    label: "Network",
    kinds: [
      { group: "",                       version: "v1", plural: "services",        kind: "Service",        scope: "Namespaced" },
      { group: "networking.k8s.io",      version: "v1", plural: "ingresses",       kind: "Ingress",        scope: "Namespaced" },
      { group: "networking.k8s.io",      version: "v1", plural: "networkpolicies", kind: "NetworkPolicy",  scope: "Namespaced" },
      { group: "discovery.k8s.io",       version: "v1", plural: "endpointslices",  kind: "EndpointSlice",  scope: "Namespaced" },
    ],
  },
  {
    label: "Storage",
    kinds: [
      { group: "",                  version: "v1", plural: "persistentvolumeclaims", kind: "PersistentVolumeClaim", scope: "Namespaced" },
      { group: "",                  version: "v1", plural: "persistentvolumes",      kind: "PersistentVolume",      scope: "Cluster" },
      { group: "storage.k8s.io",   version: "v1", plural: "storageclasses",         kind: "StorageClass",          scope: "Cluster" },
    ],
  },
  {
    label: "Cluster",
    kinds: [
      { group: "", version: "v1", plural: "namespaces",     kind: "Namespace",     scope: "Cluster" },
      { group: "", version: "v1", plural: "nodes",          kind: "Node",          scope: "Cluster" },
      { group: "", version: "v1", plural: "resourcequotas", kind: "ResourceQuota", scope: "Namespaced" },
      { group: "", version: "v1", plural: "limitranges",    kind: "LimitRange",    scope: "Namespaced" },
    ],
  },
  {
    label: "Access",
    kinds: [
      { group: "",                              version: "v1", plural: "serviceaccounts",     kind: "ServiceAccount",     scope: "Namespaced" },
      { group: "rbac.authorization.k8s.io",    version: "v1", plural: "roles",               kind: "Role",               scope: "Namespaced" },
      { group: "rbac.authorization.k8s.io",    version: "v1", plural: "rolebindings",         kind: "RoleBinding",         scope: "Namespaced" },
      { group: "rbac.authorization.k8s.io",    version: "v1", plural: "clusterroles",         kind: "ClusterRole",         scope: "Cluster" },
      { group: "rbac.authorization.k8s.io",    version: "v1", plural: "clusterrolebindings",  kind: "ClusterRoleBinding",  scope: "Cluster" },
    ],
  },
];
