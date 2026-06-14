import type { InstanceDTO, ResourceRef } from "../store/fleet";

export type ResourceRisk = { bad: boolean; reason: string };

export const CLUSTER_RISK_REFS: ResourceRef[] = [
  { group: "", version: "v1", plural: "services", kind: "Service", scope: "Namespaced" },
  { group: "discovery.k8s.io", version: "v1", plural: "endpointslices", kind: "EndpointSlice", scope: "Namespaced" },
  { group: "networking.k8s.io", version: "v1", plural: "ingresses", kind: "Ingress", scope: "Namespaced" },
  { group: "", version: "v1", plural: "persistentvolumeclaims", kind: "PersistentVolumeClaim", scope: "Namespaced" },
  { group: "", version: "v1", plural: "persistentvolumes", kind: "PersistentVolume", scope: "Cluster" },
  { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", scope: "Namespaced" },
  { group: "policy", version: "v1", plural: "poddisruptionbudgets", kind: "PodDisruptionBudget", scope: "Namespaced" },
  { group: "batch", version: "v1", plural: "jobs", kind: "Job", scope: "Namespaced" },
  { group: "batch", version: "v1", plural: "cronjobs", kind: "CronJob", scope: "Namespaced" },
  { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" },
  { group: "cert-manager.io", version: "v1", plural: "certificaterequests", kind: "CertificateRequest", scope: "Namespaced" },
  { group: "cert-manager.io", version: "v1", plural: "issuers", kind: "Issuer", scope: "Namespaced" },
  { group: "cert-manager.io", version: "v1", plural: "clusterissuers", kind: "ClusterIssuer", scope: "Cluster" },
  { group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets", kind: "ExternalSecret", scope: "Namespaced" },
  { group: "external-secrets.io", version: "v1beta1", plural: "secretstores", kind: "SecretStore", scope: "Namespaced" },
  { group: "external-secrets.io", version: "v1beta1", plural: "clustersecretstores", kind: "ClusterSecretStore", scope: "Cluster" },
  { group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases", kind: "HelmRelease", scope: "Namespaced" },
  { group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations", kind: "Kustomization", scope: "Namespaced" },
];

export function resourceKey(ref: ResourceRef): string {
  return `${ref.group}/${ref.version}/${ref.plural}`;
}

export function supportsRiskFilter(ref: ResourceRef): boolean {
  return CLUSTER_RISK_REFS.some((r) => resourceKey(r) === resourceKey(ref));
}

export function riskFor(ref: ResourceRef, row: InstanceDTO): ResourceRisk {
  const f = row.fields ?? {};
  const lower = (value: string | undefined) => (value ?? "").toLowerCase();

  if (ref.group === "" && ref.version === "v1" && ref.plural === "services") {
    if (f.type === "LoadBalancer" && lower(f.externalIP) === "pending") {
      return bad("waiting for external IP");
    }
  }

  if (ref.group === "discovery.k8s.io" && ref.plural === "endpointslices") {
    const frac = parsePair(f.endpoints);
    if (frac && frac.ready < frac.total) return bad(`${frac.total - frac.ready} endpoints not ready`);
    if (frac && frac.total === 0) return bad("no endpoints");
  }

  if (ref.group === "networking.k8s.io" && ref.plural === "ingresses") {
    if (!f.address || f.address === "-") return bad("no address");
  }

  if (ref.group === "" && ref.plural === "persistentvolumeclaims") {
    if (f.status && f.status !== "Bound") return bad(`PVC ${f.status.toLowerCase()}`);
  }

  if (ref.group === "" && ref.plural === "persistentvolumes") {
    if (["Failed", "Pending", "Released"].includes(f.status ?? "")) return bad(`PV ${f.status.toLowerCase()}`);
  }

  if (ref.group === "autoscaling" && ref.plural === "horizontalpodautoscalers") {
    const replicas = parseReplicaBand(f.replicas);
    if (replicas && replicas.current !== replicas.desired) return bad("scaling in progress");
    if (replicas && replicas.current >= replicas.max && replicas.desired >= replicas.max) return bad("at max replicas");
  }

  if (ref.group === "policy" && ref.plural === "poddisruptionbudgets") {
    const allowed = parseInt(f.allowed ?? "", 10);
    const expected = parseInt(f.expected ?? "", 10);
    if (!Number.isNaN(allowed) && allowed === 0 && (Number.isNaN(expected) || expected > 0)) {
      return bad("no disruption headroom");
    }
  }

  if (ref.group === "batch" && ref.plural === "jobs") {
    const failed = parseInt(f.failed ?? "", 10);
    if (!Number.isNaN(failed) && failed > 0) return bad(`${failed} failed`);
  }

  if (ref.group === "batch" && ref.plural === "cronjobs") {
    if (lower(f.suspended) === "yes") return bad("suspended");
  }

  if (ref.group === "cert-manager.io") {
    if (["certificates", "certificaterequests", "issuers", "clusterissuers"].includes(ref.plural)) {
      if (f.ready && f.ready !== "ready") return bad(f.ready);
      if (ref.plural === "certificaterequests" && f.denied === "ready") return bad("denied");
      const expiry = ref.plural === "certificates" ? expiryRisk(f.expires) : "";
      if (expiry) return bad(expiry);
    }
  }

  if (ref.group === "external-secrets.io") {
    if (f.ready && f.ready !== "ready") return bad(f.ready);
  }

  if (ref.group === "helm.toolkit.fluxcd.io" || ref.group === "kustomize.toolkit.fluxcd.io") {
    if (lower(f.suspended) === "yes") return bad("suspended");
    if (f.ready && f.ready !== "ready") return bad(f.ready);
  }

  return { bad: false, reason: "" };
}

function bad(reason: string): ResourceRisk {
  return { bad: true, reason };
}

function parsePair(value: string | undefined): { ready: number; total: number } | null {
  const m = (value ?? "").match(/^(\d+)\/(\d+)/);
  if (!m) return null;
  return { ready: Number(m[1]), total: Number(m[2]) };
}

function parseReplicaBand(value: string | undefined): { min: number; current: number; desired: number; max: number } | null {
  const parts = (value ?? "").split("/").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  return { min: parts[0], current: parts[1], desired: parts[2], max: parts[3] };
}

function expiryRisk(value: string | undefined): string {
  if (!value || value === "-") return "";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "";
  const days = (ms - Date.now()) / 86400000;
  if (days < 0) return "expired";
  if (days <= 30) return "expires soon";
  return "";
}
