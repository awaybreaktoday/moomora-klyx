import { useEffect, useState, useCallback, useRef } from "react";
import { useFleet } from "../store/fleet";
import type { PodDetailDTO, PodSummaryDTO, ContainerSummaryDTO } from "../store/fleet";
import { listPods, openPodDetail, deletePod } from "../bridge/pods";
import { rolloutRestart } from "../bridge/workloads";
import { copyExecCommand, openExecTerminal } from "../bridge/exec";
import { ConfirmDialog } from "../chrome/ConfirmDialog";
import { LogsPane } from "./LogsPane";
import { ForwardPopover } from "./ForwardPopover";
import { VirtualList } from "../chrome/VirtualList";
import type { VirtualListHandle } from "../chrome/VirtualList";
import { useResizablePanel } from "../chrome/useResizablePanel";
import { useListKeys } from "../chrome/useListKeys";

const rankDot: Record<string, string> = {
  unhealthy: "var(--color-text-danger)",
  degraded: "var(--color-text-warning)",
  restarts: "var(--color-text-info)",
  healthy: "var(--color-text-tertiary)",
};

function ago(s: number): string {
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const condColor = (status: string) =>
  status === "True" ? "var(--color-text-success)" : status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };

const gridCols = "12px minmax(0,1.2fr) 60px 100px 55px minmax(0,1.3fr) 52px";

export function PodsView({ cluster }: { cluster: string }) {
  const pods = useFleet((s) => s.pods);
  const isProtected = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.protected ?? false);

  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<VirtualListHandle>(null);

  useEffect(() => {
    void listPods(cluster, "");
    return () => { useFleet.getState().clearPods(); };
  }, [cluster]);

  const onNamespace = (ns: string) => { void listPods(cluster, ns); };
  const onRefresh = () => { void listPods(cluster, pods.namespace); };

  const filtered = pods.items.filter((p) => {
    if (pods.needsAttention && p.rank === "healthy") return false;
    if (pods.search) {
      const q = pods.search.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q) || p.reason.toLowerCase().includes(q);
    }
    return true;
  });

  // Clamp selectedIdx when list changes.
  const clampedIdx = filtered.length === 0 ? -1 : selectedIdx >= filtered.length ? filtered.length - 1 : selectedIdx;
  const effectiveIdx = clampedIdx;

  const handleSelect = useCallback((idx: number) => {
    setSelectedIdx(idx);
    listRef.current?.scrollToIndex(idx);
  }, []);

  const handleActivate = useCallback((idx: number) => {
    const p = filtered[idx];
    if (p) void openPodDetail(cluster, p.namespace, p.name);
  }, [filtered, cluster]);

  const handleEscape = useCallback(() => {
    if (pods.selected) {
      useFleet.getState().selectPod(null);
    }
  }, [pods.selected]);

  useListKeys({
    count: filtered.length,
    selected: effectiveIdx,
    onSelect: handleSelect,
    onActivate: handleActivate,
    onEscape: handleEscape,
    searchRef,
  });

  // Reset selection when filter changes.
  useEffect(() => {
    setSelectedIdx((prev) => {
      if (filtered.length === 0) return -1;
      return prev >= filtered.length ? filtered.length - 1 : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pods.search, pods.needsAttention, pods.namespace]);

  return (
    <div style={{ padding: "16px 20px", display: "flex", gap: 0, height: "100%", boxSizing: "border-box", position: "relative" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Controls row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>

          <select
            value={pods.namespace}
            onChange={(e) => onNamespace(e.target.value)}
            style={{ fontSize: 12, padding: "3px 6px", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4 }}
          >
            <option value="">all namespaces</option>
            {pods.namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
          </select>
          <Chip on={pods.needsAttention} onClick={() => useFleet.getState().togglePodsNeedsAttention()}>needs attention</Chip>
          <input
            ref={searchRef}
            value={pods.search}
            onChange={(e) => useFleet.getState().setPodsSearch(e.target.value)}
            placeholder="filter pods"
            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: 160 }}
          />
          <button onClick={onRefresh} style={btn}>refresh</button>
        </div>

        {/* Table */}
        {pods.loading && pods.items.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading pods…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
            {pods.items.length === 0
              ? `No pods${pods.namespace ? ` in ${pods.namespace}` : ""}.`
              : "No pods match the current filter."}
          </div>
        ) : (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)", flexShrink: 0 }}>
              <span /><span>pod</span><span>ready</span><span>phase</span><span>restarts</span><span>node</span><span>age</span>
            </div>
            {/* Rows — VirtualList for >=100 items, plain render for smaller lists */}
            <VirtualList
              ref={listRef}
              items={filtered}
              rowHeight={32}
              style={{ flex: 1, minHeight: 0 }}
              render={(p, i) => {
                const isKbSelected = i === effectiveIdx;
                const isSelected = pods.selected?.namespace === p.namespace && pods.selected?.name === p.name;
                const nonInitContainers = p.containers.filter((c) => !c.init);
                const readyCount = nonInitContainers.filter((c) => c.ready).length;
                return (
                  <div
                    key={`${p.namespace}/${p.name}`}
                    role="button"
                    tabIndex={0}
                    aria-selected={isKbSelected}
                    onClick={() => {
                      setSelectedIdx(i);
                      void openPodDetail(cluster, p.namespace, p.name);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedIdx(i);
                        void openPodDetail(cluster, p.namespace, p.name);
                      }
                    }}
                    style={{
                      display: "grid", gridTemplateColumns: gridCols, gap: 10, alignItems: "center",
                      padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                      cursor: "pointer",
                      background: isKbSelected
                        ? "var(--color-background-secondary)"
                        : isSelected ? "var(--color-background-secondary)" : undefined,
                      boxShadow: isKbSelected ? "inset 2px 0 0 var(--color-text-info)" : undefined,
                      outline: "none",
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: rankDot[p.rank] }} />
                    <span>
                      <span style={{ color: "var(--color-text-tertiary)" }}>{p.namespace}</span>
                      {" / "}
                      <span style={{ fontWeight: 500 }}>{p.name}</span>
                    </span>
                    <span style={{ color: readyCount === nonInitContainers.length ? "var(--color-text-success)" : "var(--color-text-warning)" }}>
                      {readyCount}/{nonInitContainers.length}
                    </span>
                    <span>
                      <span style={{ color: p.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
                        {p.phase}
                      </span>
                      {p.reason && (
                        <span style={{ color: p.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)", marginLeft: 4, fontSize: 10 }}>
                          {p.reason}
                        </span>
                      )}
                    </span>
                    <span style={{ color: p.restarts > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>
                      {p.restarts}
                    </span>
                    <span style={{ ...ellipsis, color: "var(--color-text-tertiary)" }} title={p.node}>{p.node}</span>
                    <span style={{ color: "var(--color-text-tertiary)" }}>{ago(p.ageSeconds)}</span>
                  </div>
                );
              }}
            />
          </div>
        )}
      </div>

      {/* Detail panel */}
      {pods.selected && (
        <PodDetailPanel
          cluster={cluster}
          namespace={pods.selected.namespace}
          name={pods.selected.name}
          detail={pods.detail}
          loading={pods.detailLoading}
          isProtected={isProtected}
          onClose={() => useFleet.getState().selectPod(null)}
        />
      )}
    </div>
  );
}

type PodPendingAction = { verb: "restart" | "delete"; summary: PodSummaryDTO };

function PodDetailPanel({
  cluster, namespace, name, detail, loading, isProtected, onClose,
}: {
  cluster: string;
  namespace: string;
  name: string;
  detail: PodDetailDTO | null;
  loading: boolean;
  isProtected: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"info" | "logs" | "yaml">("info");
  const [pending, setPending] = useState<PodPendingAction | null>(null);
  const { width, handleProps } = useResizablePanel();

  // Close on Escape. With a confirm pending, Esc cancels ONLY the confirm:
  // stopPropagation keeps the event from reaching the window-level useListKeys
  // handler (which would also close the whole panel). Without a pending confirm
  // both handlers resolve to the same idempotent selectPod(null).
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (pending) {
        e.stopPropagation();
        setPending(null);
      } else {
        onClose();
      }
    }
  }, [onClose, pending]);
  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    <div style={{
      width, flexShrink: 0, position: "relative",
      borderLeft: "0.5px solid var(--color-border-tertiary)",
      overflowY: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      paddingLeft: 16,
      marginLeft: 16,
    }}>
      {/* Resize handle — drag left edge */}
      <div {...handleProps} />

      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, position: "sticky", top: 0, background: "var(--color-background-primary)", paddingTop: 2, paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <span style={{ fontWeight: 500, ...ellipsis, flex: 1 }} title={`${namespace}/${name}`}>
          <span style={{ color: "var(--color-text-tertiary)" }}>{namespace}</span>/{name}
        </span>
        <button onClick={onClose} style={{ ...btn, padding: "2px 8px", fontSize: 12 }} aria-label="close pod detail panel">✕</button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
        {(["info", "logs", "yaml"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer",
              border: tab === t ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
              background: tab === t ? "var(--color-background-info, transparent)" : "transparent",
              color: tab === t ? "var(--color-text-info)" : "var(--color-text-tertiary)",
            }}
          >{t}</button>
        ))}
      </div>

      {loading && !detail ? (
        <div style={{ color: "var(--color-text-secondary)" }}>Loading detail…</div>
      ) : !detail ? (
        <div style={{ color: "var(--color-text-secondary)" }}>Could not load pod detail.</div>
      ) : (
        <>
          {tab === "info" && (
            <InfoTab
              detail={detail}
              cluster={cluster}
              namespace={namespace}
              name={name}
              onRestart={(s) => setPending({ verb: "restart", summary: s })}
              onDelete={(s) => setPending({ verb: "delete", summary: s })}
            />
          )}
          {tab === "logs" && (
            <div style={{ height: "calc(100vh - 160px)", display: "flex", flexDirection: "column" }}>
              <LogsPane cluster={cluster} pod={detail.summary} />
            </div>
          )}
          {tab === "yaml" && (
            <pre style={{
              margin: 0, padding: 10,
              background: "var(--color-background-secondary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: 4,
              fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5,
              overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
              color: "var(--color-text-primary)",
            }}>{detail.yaml}</pre>
          )}
        </>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.verb === "delete" ? "delete pod" : "restart owner"}
          cluster={cluster}
          detail={pending.verb === "delete"
            ? (pending.summary.ownerKind === ""
              ? `${pending.summary.namespace}/${pending.summary.name} — this pod has no controller; it will NOT be recreated.`
              : `${pending.summary.namespace}/${pending.summary.name} — the controller will recreate it.`)
            : `${pending.summary.namespace}/${pending.summary.name}`}
          protected={isProtected}
          danger={pending.verb === "delete"}
          confirmLabel={pending.verb === "delete" ? "Delete" : "Restart"}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { verb, summary } = pending;
            setPending(null);
            if (verb === "delete") {
              void deletePod(cluster, summary.namespace, summary.name);
            } else {
              // Restart the owner workload. For ReplicaSet, derive the Deployment name
              // by stripping the trailing pod-template-hash segment (the last dash-separated
              // segment added by the ReplicaSet controller), e.g. "web-7d4b9c6f9" -> "web".
              const { ownerKind, ownerName } = summary;
              let targetKind = ownerKind;
              let targetName = ownerName;
              if (ownerKind === "ReplicaSet") {
                targetKind = "Deployment";
                targetName = ownerName.split("-").slice(0, -1).join("-");
              }
              void rolloutRestart(cluster, targetKind, summary.namespace, targetName);
            }
          }}
        />
      )}
    </div>
  );
}

function InfoTab({ detail, cluster, namespace, name, onRestart, onDelete }: {
  detail: PodDetailDTO;
  cluster: string;
  namespace: string;
  name: string;
  onRestart: (s: PodSummaryDTO) => void;
  onDelete: (s: PodSummaryDTO) => void;
}) {
  const p = detail.summary;
  const [forwarding, setForwarding] = useState(false);
  // Restart is meaningful when the pod is owned by a ReplicaSet (-> Deployment),
  // StatefulSet, or DaemonSet. Standalone pods (ownerKind="") have no controller to restart.
  const showRestart = p.ownerKind === "ReplicaSet" || p.ownerKind === "StatefulSet" || p.ownerKind === "DaemonSet";

  return (
    <>
      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        {showRestart && (
          <button onClick={() => onRestart(p)} style={btn}>restart owner</button>
        )}
        {forwarding ? (
          <ForwardPopover
            cluster={cluster}
            namespace={namespace}
            kind="Pod"
            name={name}
            onClose={() => setForwarding(false)}
          />
        ) : (
          <button onClick={() => setForwarding(true)} style={btn}>forward</button>
        )}
        <ExecButtons
          cluster={cluster}
          namespace={namespace}
          pod={name}
          containers={p.containers.filter((c) => !c.init)}
        />
        <button
          onClick={() => onDelete(p)}
          style={{ ...btn, color: "var(--color-text-danger)" }}
        >delete pod</button>
      </div>

      {/* Summary header */}
      <Section title="Summary">
        <InfoRow label="phase">{p.phase}{p.reason ? ` · ${p.reason}` : ""}</InfoRow>
        {p.ownerKind && <InfoRow label="owner">{p.ownerKind}/{p.ownerName}</InfoRow>}
        {p.node && <InfoRow label="node">{p.node}</InfoRow>}
        {p.ip && <InfoRow label="ip">{p.ip}</InfoRow>}
        {detail.qosClass && <InfoRow label="qos">{detail.qosClass}</InfoRow>}
        {detail.serviceAccount && <InfoRow label="sa">{detail.serviceAccount}</InfoRow>}
      </Section>

      {/* Labels */}
      {Object.keys(detail.labels).length > 0 && (
        <Section title="Labels">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {Object.entries(detail.labels).map(([k, v]) => (
              <span key={k} style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 10, padding: "1px 5px", borderRadius: 3 }}>{k}={v}</span>
            ))}
          </div>
        </Section>
      )}

      {/* Containers */}
      <Section title={`Containers (${p.containers.length})`}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px 64px 40px", gap: 6, fontSize: 9, marginBottom: 2, color: "var(--color-text-tertiary)", textTransform: "uppercase" }}>
          <span>name</span><span>state</span><span>image</span><span>rst</span>
        </div>
        {p.containers.map((c) => (
          <div key={c.name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px 64px 40px", gap: 6, fontSize: 11, padding: "2px 0", alignItems: "center" }}>
            <span style={{ ...ellipsis }} title={c.name}>
              {c.name}
              {c.init && <span style={{ marginLeft: 4, fontSize: 9, color: "var(--color-text-tertiary)", background: "var(--color-background-secondary)", padding: "0 4px", borderRadius: 3 }}>init</span>}
            </span>
            <span style={{ color: c.ready ? "var(--color-text-success)" : "var(--color-text-danger)", ...ellipsis }} title={c.state}>{c.state || "—"}</span>
            <span style={{ ...ellipsis, color: "var(--color-text-tertiary)" }} title={c.image}>{c.image}</span>
            <span style={{ color: c.restarts > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>{c.restarts}</span>
          </div>
        ))}
      </Section>

      {/* Conditions */}
      {detail.conditions.length > 0 && (
        <Section title="Conditions">
          {detail.conditions.map((c) => (
            <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c.status), display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontWeight: 500, width: 80, flexShrink: 0 }}>{c.type}</span>
              <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
            </div>
          ))}
        </Section>
      )}

      {/* Events */}
      <Section title={`Events (${detail.events.length})`}>
        {detail.events.length === 0 ? (
          <span style={{ color: "var(--color-text-tertiary)" }}>No events for this pod.</span>
        ) : (
          detail.events.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11, color: e.type === "Warning" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
              <span style={{ width: 50, fontSize: 9, textTransform: "uppercase", flexShrink: 0 }}>{e.type}</span>
              <span style={{ fontWeight: 500, width: 100, ...ellipsis, flexShrink: 0 }}>{e.reason}</span>
              <span style={{ ...ellipsis, flex: 1 }} title={e.message}>{e.message}</span>
              {e.count > 1 && <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>×{e.count}</span>}
            </div>
          ))
        )}
      </Section>
    </>
  );
}

// ExecButtons renders "open shell" and "copy kubectl exec" buttons for a pod.
// When the pod has more than one regular (non-init) container, clicking "open shell"
// first shows a tiny container picker; with a single container it fires immediately.
function ExecButtons({
  cluster, namespace, pod, containers,
}: {
  cluster: string;
  namespace: string;
  pod: string;
  containers: ContainerSummaryDTO[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // copyState: "idle" | "copied" | "error"
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const handleOpen = (container: string) => {
    setPickerOpen(false);
    void openExecTerminal(cluster, namespace, pod, container);
  };

  const handleCopy = async () => {
    // Use first container (or "" for implicit single container) for the copy command.
    const container = containers.length === 1 ? containers[0].name : containers[0]?.name ?? "";
    const result = await copyExecCommand(cluster, namespace, pod, container);
    setCopyState(result);
    setTimeout(() => setCopyState("idle"), 1500);
  };

  const firstContainer = containers[0]?.name ?? "";

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", position: "relative" }}>
      {/* open shell button — container picker when >1 container */}
      {containers.length > 1 ? (
        <div ref={pickerRef} style={{ position: "relative" }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            style={btn}
            title="Open interactive shell in container"
          >
            open shell ▾
          </button>
          {pickerOpen && (
            <div style={{
              position: "absolute", top: "100%", left: 0, zIndex: 20, marginTop: 2,
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-secondary)",
              borderRadius: 4,
              minWidth: 160,
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            }}>
              {containers.map((c) => (
                <button
                  key={c.name}
                  onClick={() => handleOpen(c.name)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "5px 10px", fontSize: 11,
                    background: "transparent",
                    border: "none", borderBottom: "0.5px solid var(--color-border-tertiary)",
                    color: "var(--color-text-secondary)", cursor: "pointer",
                  }}
                  title={`exec into ${c.name}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => handleOpen(firstContainer)}
          style={btn}
          title="Open interactive shell"
        >
          open shell
        </button>
      )}
      {/* copy kubectl exec command */}
      <button
        onClick={() => void handleCopy()}
        style={btn}
        title="Copy kubectl exec command to clipboard"
      >
        {copyState === "copied" ? "copied!" : copyState === "error" ? "copy error" : "copy exec"}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 5 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{children}</div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
      <span style={{ color: "var(--color-text-tertiary)", width: 60, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--color-text-primary)" }}>{children}</span>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
      border: on ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
      background: on ? "var(--color-background-info, transparent)" : "transparent",
      color: on ? "var(--color-text-info)" : "var(--color-text-tertiary)",
    }}>{children}</button>
  );
}
