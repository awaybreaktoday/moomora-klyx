import type { ClusterDTO, ClusterSection } from "../store/fleet";

function message(section: ClusterSection, c: ClusterDTO): string {
  switch (section) {
    case "gitops":
      return c.gitopsTier === "Absent"
        ? "No Flux or Argo installed on this cluster."
        : "GitOps reconciliation + inline drift arrives in M3.";
    case "network":
      return c.networkTier === "Absent"
        ? "No Gateway API or Cilium installed on this cluster."
        : "Gateway topology arrives in M5.";
    case "resources":
      return "CRD browser arrives in M4.";
    case "observability":
      return "Inline metrics arrive with the Prometheus client (M7).";
    case "overview":
      return "";
    case "workloads":
      return "";
    case "pods":
      return "";
  }
}

export function Placeholder({ section, c }: { section: ClusterSection; c: ClusterDTO }) {
  return (
    <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>
      {message(section, c)}
    </div>
  );
}
