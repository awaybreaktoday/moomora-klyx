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
      { kind: "gvr",  ref: { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", scope: "Namespaced" } },
      { kind: "gvr",  ref: { group: "policy", version: "v1", plural: "poddisruptionbudgets", kind: "PodDisruptionBudget", scope: "Namespaced" } },
    ],
  },
  {
    label: "Config & Secrets",
    entries: [
      { kind: "gvr", ref: { group: "", version: "v1", plural: "configmaps", kind: "ConfigMap", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "secrets",    kind: "Secret",    scope: "Namespaced" } },
    ],
  },
  {
    label: "Services & Network",
    entries: [
      { kind: "gvr", ref: { group: "",                       version: "v1", plural: "services",        kind: "Service",        scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "networking.k8s.io",      version: "v1", plural: "ingresses",       kind: "Ingress",        scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "networking.k8s.io",      version: "v1", plural: "ingressclasses",  kind: "IngressClass",   scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "networking.k8s.io",      version: "v1", plural: "networkpolicies", kind: "NetworkPolicy",  scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "discovery.k8s.io",       version: "v1", plural: "endpointslices",  kind: "EndpointSlice",  scope: "Namespaced" } },
    ],
  },
  {
    label: "Storage",
    entries: [
      { kind: "gvr", ref: { group: "",               version: "v1", plural: "persistentvolumeclaims", kind: "PersistentVolumeClaim", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "",               version: "v1", plural: "persistentvolumes",      kind: "PersistentVolume",      scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "storage.k8s.io", version: "v1", plural: "storageclasses",         kind: "StorageClass",          scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "storage.k8s.io", version: "v1", plural: "csidrivers",             kind: "CSIDriver",             scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "storage.k8s.io", version: "v1", plural: "csinodes",               kind: "CSINode",               scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "storage.k8s.io", version: "v1", plural: "volumeattachments",      kind: "VolumeAttachment",      scope: "Cluster"    } },
    ],
  },
  {
    label: "Cluster & Scheduling",
    entries: [
      { kind: "gvr", ref: { group: "", version: "v1", plural: "namespaces",     kind: "Namespace",     scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "nodes",          kind: "Node",          scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "resourcequotas", kind: "ResourceQuota", scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "", version: "v1", plural: "limitranges",    kind: "LimitRange",    scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "scheduling.k8s.io", version: "v1", plural: "priorityclasses", kind: "PriorityClass", scope: "Cluster" } },
      { kind: "gvr", ref: { group: "node.k8s.io",       version: "v1", plural: "runtimeclasses",  kind: "RuntimeClass",  scope: "Cluster" } },
      { kind: "gvr", ref: { group: "coordination.k8s.io", version: "v1", plural: "leases",        kind: "Lease",         scope: "Namespaced" } },
    ],
  },
  {
    label: "RBAC & Admission",
    entries: [
      { kind: "gvr", ref: { group: "",                             version: "v1", plural: "serviceaccounts",                 kind: "ServiceAccount",                   scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io",     version: "v1", plural: "roles",                           kind: "Role",                             scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io",     version: "v1", plural: "rolebindings",                    kind: "RoleBinding",                      scope: "Namespaced" } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io",     version: "v1", plural: "clusterroles",                    kind: "ClusterRole",                      scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "rbac.authorization.k8s.io",     version: "v1", plural: "clusterrolebindings",             kind: "ClusterRoleBinding",               scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "admissionregistration.k8s.io",  version: "v1", plural: "mutatingwebhookconfigurations",   kind: "MutatingWebhookConfiguration",     scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "admissionregistration.k8s.io",  version: "v1", plural: "validatingwebhookconfigurations", kind: "ValidatingWebhookConfiguration",   scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "admissionregistration.k8s.io",  version: "v1", plural: "validatingadmissionpolicies",     kind: "ValidatingAdmissionPolicy",        scope: "Cluster"    } },
      { kind: "gvr", ref: { group: "admissionregistration.k8s.io",  version: "v1", plural: "validatingadmissionpolicybindings", kind: "ValidatingAdmissionPolicyBinding", scope: "Cluster"    } },
    ],
  },
];
