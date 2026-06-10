import { useEffect, useState, useCallback, useRef } from "react";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO, PodDTO, WorkloadKind, ResourceCellDTO } from "../store/fleet";
import { listWorkloads, rolloutRestart, scaleWorkload } from "../bridge/workloads";
import { getWorkloadMetrics } from "../bridge/workload-metrics";
import { ConfirmDialog } from "../chrome/ConfirmDialog";
import { saturation, nearLimitSort, fmtCpu, fmtMem } from "./saturation";
import { useListKeys } from "../chrome/useListKeys";
import { Chip } from "../chrome/Chip";

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

const tierColor: Record<string, string | undefined> = {
  none: undefined, neutral: "var(--color-text-success)", warn: "var(--color-text-warning)", danger: "var(--color-text-danger)",
};

function ResourceCellView({ resource, cell, hasPods }: { resource: "cpu" | "mem"; cell: ResourceCellDTO; hasPods: boolean }) {
  const fmt = resource === "cpu" ? fmtCpu : fmtMem;
  const usage = cell.usage == null ? "—" : fmt(cell.usage);
  if (!hasPods) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  if (cell.limit == null) {
    return <span>{usage} <span style={{ color: "var(--color-text-tertiary)" }}>· no limit</span></span>;
  }
  const sat = saturation(resource, cell.usage, cell.limit);
  const color = tierColor[sat.tier];
  return (
    <span style={{ color }}>{usage} / {fmt(cell.limit)}
      {sat.pct != null && (
        <span style={{ display: "inline-block", width: 46, height: 6, background: "var(--color-background-tertiary, #8883)", borderRadius: 3, verticalAlign: "middle", marginLeft: 6 }}>
          <span style={{ display: "block", width: `${Math.min(100, sat.pct * 100)}%`, height: "100%", background: color ?? "var(--color-text-success)", borderRadius: 3 }} />
        </span>
      )}
    </span>
  );
}

function riskLabel(resource: "cpu" | "mem", cell: ResourceCellDTO): string {
  const sat = saturation(resource, cell.usage, cell.limit);
  if (sat.pct == null || sat.tier === "none" || sat.tier === "neutral") return "";
  const pct = Math.round(sat.pct * 100);
  return resource === "mem" ? `· OOM risk ${pct}%` : `· throttling risk ${pct}%`;
}

type PendingRestart = { kind: "restart"; w: WorkloadDTO };
type PendingScale = { kind: "scale"; w: WorkloadDTO; replicas: number };
type PendingScaleInput = { kind: "scale-input"; w: WorkloadDTO };
type Pending = PendingRestart | PendingScale | PendingScaleInput;

export function WorkloadsView({ cluster }: { cluster: string }) {
  const wl = useFleet((s) => s.workloads);
  const isProtected = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.protected ?? false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listWorkloads(cluster, "").then(() => getWorkloadMetrics(cluster, ""));
    const id = setInterval(() => {
      const cur = useFleet.getState().workloads;
      if (cur.cluster === cluster) getWorkloadMetrics(cluster, cur.namespace);
    }, 30000);
    return () => { clearInterval(id); useFleet.getState().clearWorkloads(); };
  }, [cluster]);

  const onNamespace = (ns: string) => { listWorkloads(cluster, ns).then(() => getWorkloadMetrics(cluster, ns)); };
  const onRefresh = () => { listWorkloads(cluster, wl.namespace).then(() => getWorkloadMetrics(cluster, wl.namespace)); };

  const showMetrics = wl.metricsAvailable;
  const gridCols = showMetrics
    ? "12px 90px 1fr 70px 64px 1.1fr 140px 140px 130px"
    : "12px 90px 1fr 70px 64px 1.2fr 160px";
  const filtered = wl.items.filter((w) => wl.kindFilter[w.kind as WorkloadKind] && (!wl.needsAttention || w.rank !== "healthy"));
  const rows = showMetrics && wl.nearLimitSort ? nearLimitSort(filtered) : filtered;

  // Clamp selection when list changes.
  const effectiveIdx = rows.length === 0 ? -1 : selectedIdx >= rows.length ? rows.length - 1 : selectedIdx;

  const handleSelect = useCallback((idx: number) => {
    setSelectedIdx(idx);
    // WorkloadsView renders a plain list (no VirtualList), so no scrollToIndex needed —
    // the selected row uses scrollIntoView via data-wl-row attribute.
    const el = document.querySelector(`[data-wl-row="${idx}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, []);

  const handleActivate = useCallback((idx: number) => {
    const w = rows[idx];
    if (w) useFleet.getState().toggleWorkloadExpand(keyOf(w));
  }, [rows]);

  const handleEscape = useCallback(() => {
    // Collapse selected row if expanded, else no-op.
    if (effectiveIdx >= 0) {
      const w = rows[effectiveIdx];
      if (w && wl.expanded.includes(keyOf(w))) {
        useFleet.getState().toggleWorkloadExpand(keyOf(w));
      }
    }
  }, [effectiveIdx, rows, wl.expanded]);

  useListKeys({
    count: rows.length,
    selected: effectiveIdx,
    onSelect: handleSelect,
    onActivate: handleActivate,
    onEscape: handleEscape,
    searchRef,
  });

  // Reset selection on filter change.
  useEffect(() => {
    setSelectedIdx((prev) => {
      if (rows.length === 0) return -1;
      return prev >= rows.length ? rows.length - 1 : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wl.needsAttention, wl.kindFilter, wl.namespace, wl.nearLimitSort]);

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={wl.namespace} onChange={(e) => onNamespace(e.target.value)}
          style={{ fontSize: 12, padding: "3px 6px", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4 }}>
          <option value="">all namespaces</option>
          {wl.namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        {KINDS.map((k) => (
          <Chip key={k} on={wl.kindFilter[k]} onClick={() => useFleet.getState().toggleWorkloadKind(k)}>{kindShort[k]}</Chip>
        ))}
        <Chip on={wl.needsAttention} onClick={() => useFleet.getState().toggleNeedsAttention()}>needs attention</Chip>
        {showMetrics && (
          <Chip on={wl.nearLimitSort} onClick={() => useFleet.getState().toggleNearLimitSort()}>near limit</Chip>
        )}
        {/* Search input — hidden visually but focusable via "/" key */}
        <input
          ref={searchRef}
          aria-label="filter workloads"
          placeholder="filter workloads"
          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: 160 }}
        />
        <button onClick={onRefresh} style={btn}>refresh</button>
      </div>

      {wl.loading && wl.items.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading workloads…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No workloads{wl.namespace ? ` in ${wl.namespace}` : ""}.</div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>
            <span /><span>kind</span><span>workload</span><span>ready</span><span>restarts</span><span>status</span>
            {showMetrics && <span>cpu</span>}
            {showMetrics && <span>mem</span>}
            <span>gitops</span>
          </div>
          {rows.map((w, i) => {
            const expanded = wl.expanded.includes(keyOf(w));
            const isKbSelected = i === effectiveIdx;
            return (
              <div key={keyOf(w)}>
                <div
                  data-wl-row={i}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  aria-selected={isKbSelected}
                  onClick={() => {
                    setSelectedIdx(i);
                    useFleet.getState().toggleWorkloadExpand(keyOf(w));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedIdx(i);
                      useFleet.getState().toggleWorkloadExpand(keyOf(w));
                    }
                  }}
                  style={{
                    display: "grid", gridTemplateColumns: gridCols, gap: 10, alignItems: "center",
                    padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                    cursor: "pointer",
                    background: isKbSelected ? "var(--color-background-secondary)" : undefined,
                    boxShadow: isKbSelected ? "inset 2px 0 0 var(--color-text-info)" : undefined,
                    outline: "none",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: rankDot[w.rank] }} />
                  <span style={{ color: "var(--color-text-tertiary)" }}>{kindShort[w.kind as WorkloadKind]}</span>
                  <span><span style={{ color: "var(--color-text-tertiary)" }}>{w.namespace}</span> / <span style={{ fontWeight: 500 }}>{w.name}</span></span>
                  <span style={{ color: w.ready < w.desired ? "var(--color-text-warning)" : "var(--color-text-secondary)" }}>{w.ready} / {w.desired}</span>
                  <span style={{ color: w.restarts > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>{w.restarts}</span>
                  <span style={{ color: w.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>{w.reason}</span>
                  {showMetrics && <ResourceCellView resource="cpu" cell={w.resources.cpu} hasPods={w.pods.length > 0} />}
                  {showMetrics && <ResourceCellView resource="mem" cell={w.resources.mem} hasPods={w.pods.length > 0} />}
                  <span style={{ color: "var(--color-text-tertiary)" }} title={w.gitops ? `Flux ownership label: ${w.gitops.kind} ${w.gitops.namespace}/${w.gitops.name}` : undefined}>
                    {w.gitops ? `flux ${w.gitops.kind === "HelmRelease" ? "hr" : "ks"}/${w.gitops.name}` : "—"}
                  </span>
                </div>
                {expanded && showMetrics && (
                  <div style={{ display: "flex", gap: 28, fontSize: 11, padding: "6px 8px 6px 32px", background: "var(--color-background-secondary)", fontFamily: "var(--font-mono)" }}>
                    <span><span style={{ color: "var(--color-text-tertiary)" }}>cpu</span> {w.pods.length === 0 ? "—" : `usage ${w.resources.cpu.usage == null ? "—" : fmtCpu(w.resources.cpu.usage)} · req ${w.resources.cpu.request == null ? "—" : fmtCpu(w.resources.cpu.request)} · ${w.resources.cpu.limit == null ? "no limit" : `lim ${fmtCpu(w.resources.cpu.limit)}`}`} <span style={{ color: tierColor[saturation("cpu", w.resources.cpu.usage, w.resources.cpu.limit).tier] }}>{riskLabel("cpu", w.resources.cpu)}</span></span>
                    <span><span style={{ color: "var(--color-text-tertiary)" }}>mem</span> {w.pods.length === 0 ? "—" : `usage ${w.resources.mem.usage == null ? "—" : fmtMem(w.resources.mem.usage)} · req ${w.resources.mem.request == null ? "—" : fmtMem(w.resources.mem.request)} · ${w.resources.mem.limit == null ? "no limit" : `lim ${fmtMem(w.resources.mem.limit)}`}`} <span style={{ color: tierColor[saturation("mem", w.resources.mem.usage, w.resources.mem.limit).tier] }}>{riskLabel("mem", w.resources.mem)}</span></span>
                  </div>
                )}
                {expanded && (
                  <>
                    <div style={{ padding: "6px 8px 4px 32px", background: "var(--color-background-secondary)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPending({ kind: "restart", w }); }}
                        style={btn}
                      >restart</button>
                      {(w.kind === "Deployment" || w.kind === "StatefulSet") && (
                        pending?.kind === "scale-input" && pending.w === w ? (
                          <ScalePopover
                            initial={w.desired}
                            onConfirm={(n) => {
                              if (isProtected) {
                                setPending({ kind: "scale", w, replicas: n });
                              } else {
                                setPending(null);
                                void scaleWorkload(cluster, w.kind, w.namespace, w.name, n);
                              }
                            }}
                            onCancel={() => setPending(null)}
                          />
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setPending({ kind: "scale-input", w }); }}
                            style={btn}
                          >scale</button>
                        )
                      )}
                    </div>
                    <PodTable pods={w.pods} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pending?.kind === "restart" && (
        <ConfirmDialog
          title="restart"
          cluster={cluster}
          detail={`${pending.w.kind.toLowerCase()} ${pending.w.namespace}/${pending.w.name}`}
          protected={isProtected}
          confirmLabel="Restart"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { w } = pending;
            setPending(null);
            void rolloutRestart(cluster, w.kind, w.namespace, w.name);
          }}
        />
      )}
      {pending?.kind === "scale" && (
        <ConfirmDialog
          title="scale"
          cluster={cluster}
          detail={`${pending.w.kind.toLowerCase()} ${pending.w.namespace}/${pending.w.name} → ${pending.replicas} replicas`}
          protected={isProtected}
          confirmLabel="Scale"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { w, replicas } = pending;
            setPending(null);
            void scaleWorkload(cluster, w.kind, w.namespace, w.name, replicas);
          }}
        />
      )}
    </div>
  );
}

function PodTable({ pods }: { pods: PodDTO[] }) {
  if (pods.length === 0) return <div style={{ padding: "6px 8px 10px 32px", color: "var(--color-text-tertiary)", fontSize: 11 }}>no pods</div>;
  return (
    <div style={{ padding: "4px 8px 8px 32px", background: "var(--color-background-secondary)" }}>
      {pods.map((p) => (
        <div key={p.name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) 64px 50px minmax(0,1.2fr) minmax(0,1.1fr) 48px", gap: 10, fontSize: 11, padding: "3px 0", color: "var(--color-text-secondary)" }}>
          <span style={ellipsis} title={p.name}>{p.name}</span>
          <span style={{ color: p.ready ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{p.ready ? "ready" : "not ready"}</span>
          <span>{p.restarts}</span>
          <span style={{ ...ellipsis, color: p.reason ? "var(--color-text-danger)" : "var(--color-text-tertiary)" }} title={p.reason || undefined}>{p.reason || "—"}</span>
          <span style={{ ...ellipsis, color: "var(--color-text-tertiary)" }} title={p.node}>{p.node}</span>
          <span style={{ color: "var(--color-text-tertiary)", textAlign: "right" }}>{ago(p.ageSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

function ScalePopover({ initial, onConfirm, onCancel }: { initial: number; onConfirm: (n: number) => void; onCancel: () => void }) {
  const [value, setValue] = useState(String(initial));
  const n = parseInt(value, 10);
  const valid = !Number.isNaN(n) && n >= 0 && n <= 10000;
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, padding: "2px 6px", background: "var(--color-background-primary)" }}
    >
      <input
        aria-label="replica count"
        type="number"
        min={0}
        max={10000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && valid) onConfirm(n); else if (e.key === "Escape") onCancel(); }}
        autoFocus
        style={{ width: 52, fontSize: 11, padding: "2px 4px", fontFamily: "var(--font-mono)", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 3, color: "var(--color-text-primary)" }}
      />
      <button onClick={() => { if (valid) onConfirm(n); }} disabled={!valid} style={{ ...btn, padding: "2px 6px", opacity: valid ? 1 : 0.4, cursor: valid ? "pointer" : "not-allowed" }}>✓</button>
      <button onClick={onCancel} style={{ ...btn, padding: "2px 6px" }}>✕</button>
    </span>
  );
}


const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
