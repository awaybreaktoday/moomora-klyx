import { IconLock } from "@tabler/icons-react";
import type { ClusterDTO, FleetBoardEntry } from "../store/fleet";
import { useFleet, MeshGraphDTO } from "../store/fleet";

function meshRow(graph: MeshGraphDTO | null, cluster: string): string | null {
  if (!graph) return null;
  const node = graph.nodes.find((n) => n.cluster === cluster);
  if (!node || node.state === "unavailable") return "⬡ no ClusterMesh";
  if (node.state === "enabled") return "⬡ mesh enabled, no peers";
  // peered: collect peers from edges touching this cluster.
  const peers: string[] = [];
  let asym = false;
  let offFleet = 0;
  for (const e of graph.edges) {
    const other = e.a === cluster ? e.b : e.b === cluster ? e.a : null;
    if (!other) continue;
    const on = graph.nodes.find((n) => (n.cluster || n.name) === other);
    if (on && !on.present) { offFleet++; continue; }
    peers.push(other);
    if (!e.mutual) asym = true;
  }
  let row = `⇄ mesh: ${peers.join(", ") || "—"}`;
  if (asym) row += " (asymmetric)";
  if (offFleet > 0) row += ` (+${offFleet} off-fleet)`;
  return row;
}

// ClusterCard — one fleet-board ledger. Severity is a 3px edge rail (broken
// workloads or a degraded conn), utilization renders as thin bars when metrics
// exist, and GitOps state is one line in each tool's own vocabulary. An
// unreachable cluster becomes a dashed ghost stating what is known (last
// state, reason) instead of pretending to be a quiet healthy card.
export function ClusterCard({ c }: { c: ClusterDTO }) {
  const openCluster = useFleet((s) => s.openCluster);
  const mesh = useFleet((s) => s.mesh);
  const board: FleetBoardEntry | undefined = useFleet((s) => s.fleetBoard[c.name]);
  const row = meshRow(mesh, c.name);

  const unreachable = c.state === "Failed" || c.state === "Unconnected";
  const broken = (board?.broken ?? 0) > 0;
  const rail = broken ? "var(--color-text-danger)" : c.state === "Degraded" ? "var(--color-text-warning)" : "transparent";

  if (unreachable) {
    return (
      <div
        data-testid={`cluster-card-${c.name}`}
        onClick={() => openCluster(c.name)}
        style={{
          background: "var(--color-background-primary)",
          border: "0.5px dashed var(--color-border-secondary)",
          borderRadius: "var(--border-radius-md)",
          padding: "10px 12px",
          cursor: "pointer",
          color: "var(--color-text-tertiary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 12, color: "var(--color-text-secondary)" }}>{c.name}</span>
          <span style={{ fontSize: 10 }}>{c.state.toLowerCase()} · {ago(c.ageSeconds)}</span>
          {c.protected && <span title="protected" style={{ marginLeft: "auto", display: "inline-flex" }}><IconLock size={13} stroke={1.5} /></span>}
        </div>
        <div style={{ fontSize: 10, marginTop: 6 }}>{c.reason || "no connection"}</div>
        <div style={{ fontSize: 10, marginTop: 14 }}>reconnects automatically when reachable</div>
      </div>
    );
  }

  return (
    <div
      data-testid={`cluster-card-${c.name}`}
      onClick={() => openCluster(c.name)}
      style={{
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderLeft: `3px solid ${rail}`,
        borderRadius: 0,
        padding: "10px 12px",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--color-border-secondary)"; e.currentTarget.style.borderLeftColor = rail === "transparent" ? "var(--color-border-secondary)" : rail; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--color-border-tertiary)"; e.currentTarget.style.borderLeftColor = rail; }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 13 }}>{c.name}</span>
        {board?.broken != null && (
          <span style={{ fontSize: 10, color: broken ? "var(--color-text-danger)" : "var(--color-text-success)" }}>
            {broken ? `${board.broken} broken` : "quiet"}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-tertiary)" }}>
          {[c.provider, c.version].filter(Boolean).join(" · ")}
        </span>
        {c.protected && <span title="protected" style={{ display: "inline-flex", color: "var(--color-text-warning)" }}><IconLock size={13} stroke={1.5} /></span>}
      </div>

      <div style={{ display: "flex", gap: 14, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 7 }}>
        <span style={{ color: c.nodesReady < c.nodesTotal ? "var(--color-text-warning)" : undefined }}>{c.nodesReady}/{c.nodesTotal} nodes</span>
        <span>{c.pods} pods</span>
        {c.env && <span style={{ color: "var(--color-text-tertiary)" }}>{c.env}</span>}
        {c.region && <span style={{ color: "var(--color-text-tertiary)" }}>{c.region}</span>}
      </div>

      {board && board.cpuFraction != null && <UtilBar label="cpu" frac={board.cpuFraction} />}
      {board && board.memFraction != null && <UtilBar label="mem" frac={board.memFraction} />}

      <div style={{ marginTop: 8, paddingTop: 7, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
        {gitopsLine(board)}
      </div>
      {row && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>{row}</div>}
      {c.state !== "Synced" && (
        <div style={{ fontSize: 10, color: "var(--color-text-warning)", marginTop: 4 }}>
          {c.state}{c.reason ? ` — ${c.reason}` : ""}
        </div>
      )}
    </div>
  );
}

// gitopsLine speaks each tool's vocabulary: Flux is ready/not ready, Argo is
// synced/not synced. No tool detected reads "—" rather than implying health.
function gitopsLine(board: FleetBoardEntry | undefined): React.ReactNode {
  if (!board) return "gitops —";
  const parts: React.ReactNode[] = [];
  if (board.flux) {
    parts.push(
      <span key="flux">flux{" "}
        {board.flux.notReady > 0
          ? <span style={{ color: "var(--color-text-warning)" }}>{board.flux.notReady} not ready</span>
          : <span style={{ color: "var(--color-text-success)" }}>{board.flux.total} ready</span>}
      </span>,
    );
  }
  if (board.argo) {
    parts.push(
      <span key="argo">argo{" "}
        {board.argo.broken > 0
          ? <span style={{ color: "var(--color-text-warning)" }}>{board.argo.broken} not synced</span>
          : <span style={{ color: "var(--color-text-success)" }}>{board.argo.total} synced</span>}
      </span>,
    );
  }
  if (parts.length === 0) return "gitops —";
  return parts.flatMap((p, i) => (i > 0 ? [" · ", p] : [p]));
}

function UtilBar({ label, frac }: { label: string; frac: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(frac * 100)));
  const color = pct >= 90 ? "var(--color-text-danger)" : pct >= 75 ? "var(--color-text-warning)" : "var(--color-text-success)";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>
      <span style={{ width: 24 }}>{label}</span>
      <span style={{ flex: 1, height: 4, background: "var(--color-background-secondary)", borderRadius: 2, overflow: "hidden" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color }} />
      </span>
      <span style={{ fontFamily: "var(--font-mono)", width: 30, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

function ago(s: number): string {
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}
