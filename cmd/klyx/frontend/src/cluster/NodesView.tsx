import { useEffect, useCallback, useState, useRef, useLayoutEffect } from "react";
import { Events } from "@wailsio/runtime";
import { useFleet } from "../store/fleet";
import type { NodeDetailDTO, NodeSummaryDTO, PodOnNodeDTO } from "../store/fleet";
import { listNodes, openNodeDetail, cordonNode, startDrain, cancelDrain } from "../bridge/nodes";
import { ConfirmDialog } from "../chrome/ConfirmDialog";
import { fmtMem } from "./saturation";

function ago(s: number): string {
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

function nodeDotColor(n: NodeSummaryDTO): string {
  if (!n.ready || n.problems.some((p) => p === "NotReady")) return "var(--color-text-danger)";
  if (n.problems.length > 0) return "var(--color-text-danger)"; // pressure
  if (n.unschedulable) return "var(--color-text-warning)";
  return "var(--color-text-tertiary)";
}

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };

// columns: dot | name | roles | problems | version | cpu alloc/cap | mem alloc/cap | taints | age
const gridCols = "12px minmax(0,1.5fr) 80px minmax(0,1fr) 80px 100px 120px 40px 40px";

const condColor = (status: string) =>
  status === "True" ? "var(--color-text-success)" : status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)";

// --- Drain modal -----------------------------------------------------------------

interface LogChunkDTO {
  lines: string[];
  eof: boolean;
  error?: string;
}

type DrainStatus = "starting" | "running" | "ended" | "error";

function DrainModal({ cluster, node, onClose }: { cluster: string; node: string; onClose: () => void }) {
  const [status, setStatus] = useState<DrainStatus>("starting");
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);
  const streamIdRef = useRef<string>("");
  const offRef = useRef<(() => void) | null>(null);
  const bufRef = useRef<string[]>([]);
  const [version, setVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [version, follow]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom > 80) setFollow(false);
  }, []);

  useEffect(() => {
    let stale = false;

    async function open() {
      const result = await startDrain(cluster, node);
      if (stale) return;
      if (result.error || !result.streamId) {
        setStatus("error");
        setErrorMsg(result.error || "failed to start drain");
        return;
      }
      streamIdRef.current = result.streamId;
      setStatus("running");

      const eventName = `nodedrain:${result.streamId}`;
      const off = Events.On(eventName, (ev: { data: LogChunkDTO }) => {
        if (stale) return;
        const chunk = ev.data;
        if (chunk.lines && chunk.lines.length > 0) {
          bufRef.current = [...bufRef.current, ...chunk.lines];
          setVersion((v) => v + 1);
        }
        if (chunk.eof) {
          if (chunk.error) {
            setStatus("error");
            setErrorMsg(chunk.error);
          } else {
            setStatus("ended");
          }
          off();
          offRef.current = null;
          streamIdRef.current = "";
        }
      });
      offRef.current = typeof off === "function" ? off : () => {};
    }

    void open();

    return () => {
      stale = true;
      if (offRef.current) { offRef.current(); offRef.current = null; }
      const sid = streamIdRef.current;
      if (sid) {
        streamIdRef.current = "";
        void cancelDrain(sid);
      }
    };
  }, [cluster, node]);

  const handleCancel = useCallback(() => {
    if (offRef.current) { offRef.current(); offRef.current = null; }
    const sid = streamIdRef.current;
    if (sid) {
      streamIdRef.current = "";
      void cancelDrain(sid);
    }
    onClose();
  }, [onClose]);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape" && (status === "ended" || status === "error")) onClose();
  }, [status, onClose]);
  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  const lines = bufRef.current;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && (status === "ended" || status === "error")) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
    >
      <div
        style={{
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-secondary)",
          borderRadius: "var(--border-radius-md)",
          padding: 20,
          width: 620,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontWeight: 600, flex: 1 }}>Drain node: <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{node}</span></span>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
            {status === "running" && (
              <>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-text-success)", display: "inline-block" }} />
                <span style={{ color: "var(--color-text-success)" }}>draining</span>
              </>
            )}
            {status === "starting" && <span style={{ color: "var(--color-text-tertiary)" }}>starting…</span>}
            {status === "ended" && <span style={{ color: "var(--color-text-success)" }}>complete</span>}
            {status === "error" && <span style={{ color: "var(--color-text-danger)" }} title={errorMsg}>failed: {errorMsg}</span>}
          </div>
        </div>

        {/* Log area */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1, minHeight: 0, maxHeight: 400,
            overflowY: "auto",
            background: "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: 4,
            padding: "6px 8px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.55,
            color: "var(--color-text-primary)",
            marginBottom: 12,
          }}
        >
          {lines.length === 0 && status === "starting" && (
            <span style={{ color: "var(--color-text-tertiary)" }}>starting…</span>
          )}
          {lines.map((line, i) => (
            <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line || "​"}</div>
          ))}
        </div>

        {/* Footer buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {(status === "running" || status === "starting") && (
            <button onClick={handleCancel} style={{ ...btn, color: "var(--color-text-danger)", borderColor: "var(--color-text-danger)" }}>
              Cancel drain
            </button>
          )}
          {(status === "ended" || status === "error") && (
            <button onClick={onClose} style={btn}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main view -------------------------------------------------------------------

export function NodesView({ cluster }: { cluster: string }) {
  const nodes = useFleet((s) => s.nodes);
  const isProtected = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.protected ?? false);
  const actionStatus = useFleet((s) => s.actionStatus);

  const [drainNode, setDrainNode] = useState<string | null>(null);
  const [cordonPending, setCordonPending] = useState<{ node: string; cordon: boolean } | null>(null);
  const [drainPending, setDrainPending] = useState<string | null>(null);

  useEffect(() => {
    void listNodes(cluster);
    return () => { useFleet.getState().clearNodes(); };
  }, [cluster]);

  const onRefresh = () => { void listNodes(cluster); };

  return (
    <div style={{ padding: "16px 20px", display: "flex", gap: 0, height: "100%", boxSizing: "border-box", position: "relative" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Controls row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <button onClick={onRefresh} style={btn}>refresh</button>
          {actionStatus && (
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 3,
              color: actionStatus.kind === "error" ? "var(--color-text-danger)" : "var(--color-text-success)",
              background: actionStatus.kind === "error" ? "var(--color-background-danger, transparent)" : "var(--color-background-success, transparent)",
            }}>
              {actionStatus.message}
              <button onClick={() => useFleet.getState().clearActionStatus()} style={{ marginLeft: 6, background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "inherit" }}>✕</button>
            </span>
          )}
        </div>

        {/* Table */}
        {nodes.loading && nodes.items.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading nodes…</div>
        ) : nodes.items.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No nodes found.</div>
        ) : (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>
              <span /><span>node</span><span>roles</span><span>problems</span><span>version</span><span>cpu alloc/cap</span><span>mem alloc/cap</span><span>taints</span><span>age</span>
            </div>
            {/* Rows */}
            {nodes.items.map((n) => {
              const isSelected = nodes.selected?.name === n.name;
              const dotColor = nodeDotColor(n);
              const problemText = n.problems.length > 0
                ? n.problems.join(", ")
                : n.unschedulable
                ? "cordoned"
                : "";
              const problemColor = !n.ready || n.problems.length > 0
                ? "var(--color-text-danger)"
                : n.unschedulable
                ? "var(--color-text-warning)"
                : undefined;
              return (
                <div
                  key={n.name}
                  onClick={() => void openNodeDetail(cluster, n.name)}
                  style={{
                    display: "grid", gridTemplateColumns: gridCols, gap: 10, alignItems: "center",
                    padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)",
                    cursor: "pointer",
                    background: isSelected ? "var(--color-background-secondary)" : undefined,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
                  <span style={{ fontWeight: 500, ...ellipsis }} title={n.name}>{n.name}</span>
                  <span style={{ color: "var(--color-text-tertiary)", ...ellipsis }}>
                    {n.roles.length > 0 ? n.roles.join(", ") : "-"}
                  </span>
                  <span style={{ color: problemColor, ...ellipsis }}>{problemText}</span>
                  <span style={{ color: "var(--color-text-tertiary)", ...ellipsis }}>{n.version}</span>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    {n.cpuAllocatable.toFixed(1)}
                    <span style={{ color: "var(--color-text-tertiary)" }}> / {n.cpuCapacity.toFixed(1)}</span>
                  </span>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    {fmtMem(n.memAllocatable)}
                    <span style={{ color: "var(--color-text-tertiary)" }}> / {fmtMem(n.memCapacity)}</span>
                  </span>
                  <span style={{ color: n.taintCount > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>
                    {n.taintCount > 0 ? n.taintCount : "-"}
                  </span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{ago(n.ageSeconds)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {nodes.selected && (
        <NodeDetailPanel
          cluster={cluster}
          name={nodes.selected.name}
          detail={nodes.detail}
          loading={nodes.detailLoading}
          isProtected={isProtected}
          onCordon={(node, cordon) => setCordonPending({ node, cordon })}
          onDrain={(node) => setDrainPending(node)}
          onClose={() => useFleet.getState().selectNode(null)}
        />
      )}

      {/* Cordon/uncordon confirm dialog */}
      {cordonPending && (
        <ConfirmDialog
          title={cordonPending.cordon ? "Cordon node" : "Uncordon node"}
          cluster={cluster}
          detail={`node ${cordonPending.node} will be marked ${cordonPending.cordon ? "unschedulable" : "schedulable"}`}
          protected={isProtected}
          danger={cordonPending.cordon}
          confirmLabel={cordonPending.cordon ? "Cordon" : "Uncordon"}
          onConfirm={() => {
            const { node, cordon } = cordonPending;
            setCordonPending(null);
            void cordonNode(cluster, node, cordon);
          }}
          onCancel={() => setCordonPending(null)}
        />
      )}

      {/* Drain confirm dialog */}
      {drainPending && (
        <ConfirmDialog
          title="Drain node"
          cluster={cluster}
          detail={`kubectl drain ${drainPending} --ignore-daemonsets --delete-emptydir-data`}
          protected={isProtected}
          danger
          confirmLabel="Drain"
          onConfirm={() => {
            const node = drainPending;
            setDrainPending(null);
            setDrainNode(node);
          }}
          onCancel={() => setDrainPending(null)}
        />
      )}

      {/* Drain modal */}
      {drainNode && (
        <DrainModal
          cluster={cluster}
          node={drainNode}
          onClose={() => {
            setDrainNode(null);
            void listNodes(cluster);
          }}
        />
      )}
    </div>
  );
}

function NodeDetailPanel({
  cluster, name, detail, loading, isProtected, onCordon, onDrain, onClose,
}: {
  cluster: string;
  name: string;
  detail: NodeDetailDTO | null;
  loading: boolean;
  isProtected: boolean;
  onCordon: (node: string, cordon: boolean) => void;
  onDrain: (node: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"info" | "yaml">("info");
  const [labelsExpanded, setLabelsExpanded] = useState(false);

  // suppress unused warning — isProtected propagated for cordon/drain callers above
  void isProtected;

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);
  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    <div style={{
      width: 480, flexShrink: 0,
      borderLeft: "0.5px solid var(--color-border-tertiary)",
      overflowY: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      paddingLeft: 16,
      marginLeft: 16,
    }}>
      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, position: "sticky", top: 0, background: "var(--color-background-primary)", paddingTop: 2, paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
        <button onClick={onClose} style={{ ...btn, padding: "2px 8px", fontSize: 12 }}>✕</button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
        {(["info", "yaml"] as const).map((t) => (
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
        <div style={{ color: "var(--color-text-secondary)" }}>Could not load node detail.</div>
      ) : (
        <>
          {tab === "info" && (
            <InfoTab
              detail={detail}
              cluster={cluster}
              labelsExpanded={labelsExpanded}
              onToggleLabels={() => setLabelsExpanded((x) => !x)}
              onCordon={onCordon}
              onDrain={onDrain}
            />
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
    </div>
  );
}

function InfoTab({ detail, cluster, labelsExpanded, onToggleLabels, onCordon, onDrain }: {
  detail: NodeDetailDTO;
  cluster: string;
  labelsExpanded: boolean;
  onToggleLabels: () => void;
  onCordon: (node: string, cordon: boolean) => void;
  onDrain: (node: string) => void;
}) {
  const n = detail.summary;
  const setSection = useFleet((s) => s.setSection);

  const handlePodClick = (pod: PodOnNodeDTO) => {
    // Cross-link to pods section: set section and let PodsView load
    setSection("pods");
    // Note: actual pod detail opening requires a full pods load first.
    // We navigate to pods section; the user can click the pod from there.
    void cluster; // cluster is used by the parent; this nav is section-only
  };

  return (
    <>
      {/* Actions row */}
      <NodeSection title="Actions">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {n.unschedulable ? (
            <button
              aria-label="uncordon"
              onClick={() => onCordon(n.name, false)}
              style={{ ...btn, color: "var(--color-text-success)", borderColor: "var(--color-text-success)" }}
            >
              uncordon
            </button>
          ) : (
            <button
              aria-label="cordon"
              onClick={() => onCordon(n.name, true)}
              style={{ ...btn, color: "var(--color-text-warning)", borderColor: "var(--color-text-warning)" }}
            >
              cordon
            </button>
          )}
          <button
            aria-label="drain"
            onClick={() => onDrain(n.name)}
            style={{ ...btn, color: "var(--color-text-danger)", borderColor: "var(--color-text-danger)" }}
          >
            drain
          </button>
        </div>
      </NodeSection>

      {/* Summary header */}
      <NodeSection title="Summary">
        <NodeInfoRow label="ready">{n.ready ? "True" : "False"}</NodeInfoRow>
        {n.unschedulable && <NodeInfoRow label="cordoned"><span style={{ color: "var(--color-text-warning)" }}>yes</span></NodeInfoRow>}
        {n.roles.length > 0 && <NodeInfoRow label="roles">{n.roles.join(", ")}</NodeInfoRow>}
        <NodeInfoRow label="version">{n.version || "-"}</NodeInfoRow>
        <NodeInfoRow label="os">{n.os || "-"}</NodeInfoRow>
        <NodeInfoRow label="arch">{n.arch || "-"}</NodeInfoRow>
        <NodeInfoRow label="cpu">{n.cpuAllocatable.toFixed(1)} alloc / {n.cpuCapacity.toFixed(1)} cap</NodeInfoRow>
        <NodeInfoRow label="mem">{fmtMem(n.memAllocatable)} alloc / {fmtMem(n.memCapacity)} cap</NodeInfoRow>
        {n.podCapacity > 0 && <NodeInfoRow label="pods">{n.podCapacity} max</NodeInfoRow>}
        {n.problems.length > 0 && (
          <NodeInfoRow label="problems"><span style={{ color: "var(--color-text-danger)" }}>{n.problems.join(", ")}</span></NodeInfoRow>
        )}
      </NodeSection>

      {/* Conditions */}
      {detail.conditions.length > 0 && (
        <NodeSection title="Conditions">
          {detail.conditions.map((c) => (
            <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c.status), display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontWeight: 500, width: 100, flexShrink: 0 }}>{c.type}</span>
              <span style={{ color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.message}>{c.message || c.reason || "-"}</span>
            </div>
          ))}
        </NodeSection>
      )}

      {/* Taints */}
      {detail.taints.length > 0 && (
        <NodeSection title={`Taints (${detail.taints.length})`}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,0.6fr) 80px", gap: 6, fontSize: 9, marginBottom: 2, color: "var(--color-text-tertiary)", textTransform: "uppercase" }}>
            <span>key</span><span>value</span><span>effect</span>
          </div>
          {detail.taints.map((t, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,0.6fr) 80px", gap: 6, fontSize: 11, padding: "2px 0", alignItems: "center" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.key}>{t.key}</span>
              <span style={{ color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.value || "-"}</span>
              <span style={{ color: "var(--color-text-secondary)" }}>{t.effect}</span>
            </div>
          ))}
        </NodeSection>
      )}

      {/* Labels (collapsed by default) */}
      {Object.keys(detail.labels).length > 0 && (
        <NodeSection title={`Labels (${Object.keys(detail.labels).length})`} action={
          <button onClick={onToggleLabels} style={{ ...btn, fontSize: 9, padding: "1px 6px" }}>
            {labelsExpanded ? "collapse" : "expand"}
          </button>
        }>
          {labelsExpanded && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {Object.entries(detail.labels).map(([k, v]) => (
                <span key={k} style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 10, padding: "1px 5px", borderRadius: 3 }}>{k}{v ? `=${v}` : ""}</span>
              ))}
            </div>
          )}
        </NodeSection>
      )}

      {/* Pods on node */}
      <NodeSection title={`Pods on node (${detail.podsOnNode.length})`}>
        {detail.podsOnNode.length === 0 ? (
          <span style={{ color: "var(--color-text-tertiary)" }}>No pods scheduled on this node.</span>
        ) : (
          detail.podsOnNode.map((p) => (
            <div
              key={`${p.namespace}/${p.name}`}
              onClick={() => handlePodClick(p)}
              style={{ display: "flex", gap: 8, fontSize: 11, cursor: "pointer", padding: "2px 0", alignItems: "baseline" }}
            >
              <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>{p.namespace}</span>
              <span style={{ fontWeight: 500 }}>{p.name}</span>
              <span style={{ color: p.phase === "Running" ? "var(--color-text-success)" : p.phase === "Failed" ? "var(--color-text-danger)" : "var(--color-text-tertiary)", marginLeft: "auto", flexShrink: 0 }}>{p.phase}</span>
            </div>
          ))
        )}
      </NodeSection>

      {/* Events */}
      <NodeSection title={`Events (${detail.events.length})`}>
        {detail.events.length === 0 ? (
          <span style={{ color: "var(--color-text-tertiary)" }}>No events for this node.</span>
        ) : (
          detail.events.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11, color: e.type === "Warning" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
              <span style={{ width: 50, fontSize: 9, textTransform: "uppercase", flexShrink: 0 }}>{e.type}</span>
              <span style={{ fontWeight: 500, width: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{e.reason}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={e.message}>{e.message}</span>
              {e.count > 1 && <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>×{e.count}</span>}
            </div>
          ))
        )}
      </NodeSection>
    </>
  );
}

function NodeSection({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>{title}</span>
        {action}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{children}</div>
    </div>
  );
}

function NodeInfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
      <span style={{ color: "var(--color-text-tertiary)", width: 70, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--color-text-primary)" }}>{children}</span>
    </div>
  );
}
