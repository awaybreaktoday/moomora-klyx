import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO, PodDTO, WorkloadKind } from "../store/fleet";
import { listWorkloads } from "../bridge/workloads";

const rankDot: Record<string, string> = {
  unhealthy: "var(--color-text-danger)",
  degraded: "var(--color-text-warning)",
  restarts: "var(--color-text-info)",
  healthy: "var(--color-text-tertiary)",
};
const KINDS: WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet"];
const kindShort: Record<WorkloadKind, string> = { Deployment: "deploy", StatefulSet: "sts", DaemonSet: "daemonset" };
const keyOf = (w: WorkloadDTO) => `${w.kind}/${w.namespace}/${w.name}`;
function ago(s: number): string { return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }

export function WorkloadsView({ cluster }: { cluster: string }) {
  const wl = useFleet((s) => s.workloads);
  useEffect(() => {
    listWorkloads(cluster, "");
    return () => useFleet.getState().clearWorkloads();
  }, [cluster]);

  const rows = wl.items.filter((w) => wl.kindFilter[w.kind as WorkloadKind] && (!wl.needsAttention || w.rank !== "healthy"));

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={wl.namespace} onChange={(e) => listWorkloads(cluster, e.target.value)}
          style={{ fontSize: 12, padding: "3px 6px", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4 }}>
          <option value="">all namespaces</option>
          {wl.namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        {KINDS.map((k) => (
          <Chip key={k} on={wl.kindFilter[k]} onClick={() => useFleet.getState().toggleWorkloadKind(k)}>{kindShort[k]}</Chip>
        ))}
        <Chip on={wl.needsAttention} onClick={() => useFleet.getState().toggleNeedsAttention()}>needs attention</Chip>
        <button onClick={() => listWorkloads(cluster, wl.namespace)} style={btn}>refresh</button>
      </div>

      {wl.loading && wl.items.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading workloads…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No workloads{wl.namespace ? ` in ${wl.namespace}` : ""}.</div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "12px 90px 1fr 70px 64px 1.2fr 160px", gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>
            <span /><span>kind</span><span>workload</span><span>ready</span><span>restarts</span><span>status</span><span>gitops</span>
          </div>
          {rows.map((w) => {
            const expanded = wl.expanded.includes(keyOf(w));
            return (
              <div key={keyOf(w)}>
                <div onClick={() => useFleet.getState().toggleWorkloadExpand(keyOf(w))}
                  style={{ display: "grid", gridTemplateColumns: "12px 90px 1fr 70px 64px 1.2fr 160px", gap: 10, alignItems: "center", padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: rankDot[w.rank] }} />
                  <span style={{ color: "var(--color-text-tertiary)" }}>{kindShort[w.kind as WorkloadKind]}</span>
                  <span><span style={{ color: "var(--color-text-tertiary)" }}>{w.namespace}</span> / <span style={{ fontWeight: 500 }}>{w.name}</span></span>
                  <span style={{ color: w.ready < w.desired ? "var(--color-text-warning)" : "var(--color-text-secondary)" }}>{w.ready} / {w.desired}</span>
                  <span style={{ color: w.restarts > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>{w.restarts}</span>
                  <span style={{ color: w.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>{w.reason}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }} title={w.gitops ? `Flux ownership label: ${w.gitops.kind} ${w.gitops.namespace}/${w.gitops.name}` : undefined}>
                    {w.gitops ? `flux ${w.gitops.kind === "HelmRelease" ? "hr" : "ks"}/${w.gitops.name}` : "—"}
                  </span>
                </div>
                {expanded && <PodTable pods={w.pods} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PodTable({ pods }: { pods: PodDTO[] }) {
  if (pods.length === 0) return <div style={{ padding: "6px 8px 10px 32px", color: "var(--color-text-tertiary)", fontSize: 11 }}>no pods</div>;
  return (
    <div style={{ padding: "4px 8px 8px 32px", background: "var(--color-background-secondary)" }}>
      {pods.map((p) => (
        <div key={p.name} style={{ display: "grid", gridTemplateColumns: "1fr 60px 56px 1fr 120px 50px", gap: 10, fontSize: 11, padding: "3px 0", color: "var(--color-text-secondary)" }}>
          <span>{p.name}</span>
          <span style={{ color: p.ready ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{p.ready ? "ready" : "not ready"}</span>
          <span>{p.restarts}</span>
          <span style={{ color: p.reason ? "var(--color-text-danger)" : "var(--color-text-tertiary)" }}>{p.reason || "—"}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>{p.node}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>{ago(p.ageSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
      border: on ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
      background: on ? "var(--color-background-info, transparent)" : "transparent",
      color: on ? "var(--color-text-info)" : "var(--color-text-tertiary)" }}>{children}</button>
  );
}

const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };
