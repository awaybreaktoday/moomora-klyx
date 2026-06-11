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
  count: number | null;
  label: string;
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
    { key: "workloads", count: tape.counts.workloads, label: "unhealthy workloads", variant: "danger", go: () => { nav.setSection("workloads"); nav.setWorkloadsNeedsAttention(true); } },
    { key: "pods", count: tape.counts.pods, label: "pods not ready", variant: "danger", go: () => { nav.setSection("pods"); nav.setPodsNeedsAttention(true); } },
    { key: "events", count: tape.counts.events, label: "warning events", variant: "warning", go: () => { nav.setSection("events"); nav.setWarningsOnly(true); } },
    { key: "nodes", count: tape.counts.nodes, label: "node problems", variant: "danger", go: () => nav.setSection("nodes") },
    { key: "helm", count: tape.counts.helm, label: "failed releases", variant: "danger", go: () => nav.setSection("helm") },
    { key: "flux", count: tape.counts.flux, label: "flux not ready", variant: "danger", go: () => nav.setSection("gitops") },
    { key: "argo", count: tape.counts.argo, label: "argo not synced", variant: "warning", go: () => nav.setSection("argo") },
  ];

  const alerts = chips.filter((c) => (c.count ?? 0) > 0);
  const readable = chips.filter((c) => c.count !== null);

  let trailer: string;
  if (tape.loading && readable.length === 0) trailer = "checking…";
  else if (readable.length === 0) trailer = "triage unavailable";
  else if (alerts.length === 0) trailer = "everything is quiet";
  else if (readable.length < chips.length) trailer = "some lenses unreadable";
  else trailer = "everything else is quiet";

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
          aria-label={`${c.count} ${c.label}`}
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
          {c.count} {c.label}
        </button>
      ))}
      <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)" }}>{trailer}</span>
    </div>
  );
}
