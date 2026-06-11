import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import { fetchTape } from "../bridge/tape";

// TriageTape — the one-line attention ribbon under the header on EVERY cluster
// section (from the approved mockups). Each nonzero count is a chip that jumps
// to the filtered lens; all-zero says "everything is quiet" explicitly - the
// most common answer a daily driver gives should be a definitive all-clear.
// Counts the fetch could not read are skipped, and if NOTHING could be read
// the tape says so rather than implying quiet.

type Chip = {
  key: string;
  count: import("../store/fleet").LensCount;
  label: [string, string]; // [singular, plural]
  variant: "danger" | "warning";
  go: () => void;
};

export function TriageTape({ cluster }: { cluster: string }) {
  const tape = useFleet((s) => s.tape);

  // One fetch per cluster entry; section switches do not refetch.
  useEffect(() => {
    void fetchTape(cluster);
    return () => useFleet.getState().clearTape();
  }, [cluster]);

  if (tape.cluster !== cluster) return null;

  const nav = useFleet.getState();
  const chips: Chip[] = [
    { key: "workloads", count: tape.counts.workloads, label: ["unhealthy workload", "unhealthy workloads"], variant: "danger", go: () => { nav.setSection("workloads"); nav.setWorkloadsNeedsAttention(true); } },
    { key: "pods", count: tape.counts.pods, label: ["pod not ready", "pods not ready"], variant: "danger", go: () => { nav.setSection("pods"); nav.setPodsNeedsAttention(true); } },
    { key: "events", count: tape.counts.events, label: ["warning event", "warning events"], variant: "warning", go: () => { nav.setSection("events"); nav.setWarningsOnly(true); } },
    { key: "nodes", count: tape.counts.nodes, label: ["node problem", "node problems"], variant: "danger", go: () => nav.setSection("nodes") },
    { key: "helm", count: tape.counts.helm, label: ["failed release", "failed releases"], variant: "danger", go: () => nav.setSection("helm") },
    { key: "flux", count: tape.counts.flux, label: ["flux not ready", "flux not ready"], variant: "danger", go: () => nav.setSection("gitops") },
    { key: "argo", count: tape.counts.argo, label: ["argo app not synced", "argo apps not synced"], variant: "warning", go: () => nav.setSection("argo") },
  ];

  // Absent tools are excluded entirely - a Flux-only cluster has no argo lens,
  // which is expected, not unreadable.
  const present = chips.filter((c) => c.count !== "absent");
  const alerts = present.filter((c) => typeof c.count === "number" && c.count > 0);
  const readable = present.filter((c) => typeof c.count === "number");
  const unreadable = present.length - readable.length;

  let trailer: string;
  if (tape.loading && readable.length === 0) trailer = "checking…";
  else if (readable.length === 0) trailer = "triage unavailable";
  else if (alerts.length === 0) trailer = unreadable > 0 ? `quiet · ${unreadable} lens${unreadable === 1 ? "" : "es"} unreadable` : "everything is quiet";
  else trailer = unreadable > 0 ? `${unreadable} lens${unreadable === 1 ? "" : "es"} unreadable` : "everything else is quiet";

  return (
    <div
      data-testid="triage-tape"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 16px",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <span style={{ color: "var(--color-text-tertiary)" }}>triage</span>
      {alerts.map((c) => (
        <button
          key={c.key}
          onClick={c.go}
          aria-label={`${c.count} ${c.count === 1 ? c.label[0] : c.label[1]}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 8px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            borderRadius: 999,
            border: "none",
            cursor: "pointer",
            background: c.variant === "danger" ? "var(--color-background-danger)" : "var(--color-background-warning)",
            color: c.variant === "danger" ? "var(--color-text-danger)" : "var(--color-text-warning)",
          }}
        >
          {c.count} {c.count === 1 ? c.label[0] : c.label[1]}
        </button>
      ))}
      <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)" }}>{trailer}</span>
    </div>
  );
}
