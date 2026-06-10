import { ClusterSection, ResourceRef } from "../store/fleet";

export type BuiltinEntry =
  | { kind: "gvr"; ref: ResourceRef }
  | { kind: "lens"; label: string; section: ClusterSection; hint: string };

export type BuiltinCategory = { label: string; entries: BuiltinEntry[] };

export const BUILTIN_CATALOG: BuiltinCategory[] = [
  {
    label: "Workloads",
    entries: [
      { kind: "lens", label: "Deployments",   section: "workloads", hint: "health lens" },
      { kind: "lens", label: "StatefulSets",  section: "workloads", hint: "health lens" },
      { kind: "lens", label: "DaemonSets",    section: "workloads", hint: "health lens" },
      { kind: "lens", label: "Pods",          section: "pods",      hint: "health lens" },
      { kind: "gvr",  ref: { group: "batch", version: "v1", plural: "jobs",       kind: "Job",       scope: "Namespaced" } },
      { kind: "gvr",  ref: { group: "batch", version: "v1", plural: "cronjobs",   kind: "CronJob",   scope: "Namespaced" } },
      { kind: "gvr",  ref: { group: "apps",  version: "v1", plural: "replicasets", kind: "ReplicaSet", scope: "Namespaced" } },
    ],
  },
  {
    label: "Config",
    entries: [
      { kind: "gvr", ref: { group: "", version: "v1", plural: "configmaps", kind: "ConfigMap", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "secrets",    kind: "Secret",    scope: "Namespaced" } },
    ],
  },
  {
    label: "Network",
    entries: [
      { kind: "gvr", ref: { group: "",                       version: "v1", plural: "services",        kind: "Service",        scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "networking.k8s.io",      version: "v1", plural: "ingresses",       kind: "Ingress",        scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "networking.k8s.io",      version: "v1", plural: "networkpolicies", kind: "NetworkPolicy",  scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "discovery.k8s.io",       version: "v1", plural: "endpointslices",  kind: "EndpointSlice",  scope: "Namespaced" } },
    ],
  },
  {
    label: "Storage",
    entries: [
      { kind: "gvr", ref: { group: "",                version: "v1", plural: "persistentvolumeclaims", kind: "PersistentVolumeClaim", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "",                version: "v1", plural: "persistentvolumes",      kind: "PersistentVolume",      scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "storage.k8s.io", version: "v1", plural: "storageclasses",         kind: "StorageClass",          scope: "Cluster"    } },
    ],
  },
  {
    label: "Cluster",
    entries: [
      { kind: "gvr", ref: { group: "", version: "v1", plural: "namespaces",     kind: "Namespace",     scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "nodes",          kind: "Node",          scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "resourcequotas", kind: "ResourceQuota", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "limitranges",    kind: "LimitRange",    scope: "Namespaced" } },
    ],
  },
  {
    label: "Access",
    entries: [
      { kind: "gvr", ref: { group: "",                           version: "v1", plural: "serviceaccounts",    kind: "ServiceAccount",    scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io", version: "v1", plural: "roles",              kind: "Role",              scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io", version: "v1", plural: "rolebindings",       kind: "RoleBinding",       scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterroles",       kind: "ClusterRole",       scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterrolebindings", kind: "ClusterRoleBinding", scope: "Cluster"   } },
    ],
  },
];
