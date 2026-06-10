import { useEffect, useState } from "react";
import { useFleet } from "../store/fleet";
import type { EventRowDTO } from "../store/fleet";
import { listEvents } from "../bridge/events";
import { openPodDetail } from "../bridge/pods";
import { VirtualList } from "../chrome/VirtualList";

function ago(unix: number): string {
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 0) return "just now";
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const btn: React.CSSProperties = {
  fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-primary)", color: "var(--color-text-secondary)",
};

// type dot · count · age · ns · kind/name · reason · message
const gridCols = "10px 32px 44px minmax(0,0.9fr) minmax(0,1.1fr) 90px minmax(0,2fr)";

export function EventsView({ cluster }: { cluster: string }) {
  const events = useFleet((s) => s.events);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void listEvents(cluster, "");
    return () => { useFleet.getState().clearEvents(); };
  }, [cluster]);

  const onNamespace = (ns: string) => { void listEvents(cluster, ns); };
  const onRefresh = () => { void listEvents(cluster, events.namespace); };

  const filtered = events.items.filter((e) => {
    if (events.warningsOnly && e.type !== "Warning") return false;
    if (events.search) {
      const q = events.search.toLowerCase();
      return (
        e.reason.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.namespace.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" }}>
      {/* Controls row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select
          value={events.namespace}
          onChange={(e) => onNamespace(e.target.value)}
          style={{ fontSize: 12, padding: "3px 6px", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4 }}
        >
          <option value="">all namespaces</option>
          {events.namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <Chip on={events.warningsOnly} onClick={() => useFleet.getState().toggleWarningsOnly()}>warnings only</Chip>
        <input
          value={events.search}
          onChange={(e) => useFleet.getState().setEventsSearch(e.target.value)}
          placeholder="filter events"
          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: 160 }}
        />
        <button onClick={onRefresh} style={btn}>refresh</button>
      </div>

      {/* Table */}
      {events.loading && events.items.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading events…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
          {events.items.length === 0
            ? `No events${events.namespace ? ` in ${events.namespace}` : ""}.`
            : "No events match the current filter."}
        </div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Header */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)", flexShrink: 0 }}>
            <span /><span>×</span><span>age</span><span>namespace</span><span>involved</span><span>reason</span><span>message</span>
          </div>
          {/*
           * VirtualList for >=100 rows with no expansions.
           * When any row is expanded, the expanded message block has variable
           * height which breaks fixed-row virtualization math. In that case we
           * bail to plain rendering. In practice users expand rows to read
           * details at which point the list is short (after filtering), so the
           * plain path is fast and correct.
           */}
          <VirtualList
            items={filtered}
            rowHeight={30}
            style={{ flex: 1, minHeight: 0, ...(expanded.size > 0 ? { overflowY: "auto" } : {}) }}
            render={(e, i) => (
              <EventRow
                key={`${e.namespace}/${e.kind}/${e.name}/${e.reason}/${i}`}
                event={e}
                cluster={cluster}
                expanded={expanded.has(`${e.namespace}/${e.kind}/${e.name}/${e.reason}/${i}`)}
                onToggle={() => toggleExpand(`${e.namespace}/${e.kind}/${e.name}/${e.reason}/${i}`)}
              />
            )}
          />
        </div>
      )}
    </div>
  );
}

function EventRow({ event: e, cluster, expanded, onToggle }: {
  event: EventRowDTO;
  cluster: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isWarning = e.type === "Warning";

  const handlePodLink = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    // Navigate to pods section first, then open pod detail
    useFleet.getState().setSection("pods");
    void openPodDetail(cluster, e.namespace, e.name);
  };

  const involvedCell = e.kind === "Pod" ? (
    <button
      onClick={handlePodLink}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        color: "var(--color-text-info)", fontFamily: "inherit", fontSize: "inherit",
        textAlign: "left", ...ellipsis,
      }}
      title={`${e.kind}/${e.name}`}
    >
      <span style={{ color: "var(--color-text-tertiary)" }}>{e.kind}/</span>
      {e.name}
    </button>
  ) : (
    <span style={{ ...ellipsis, color: "var(--color-text-secondary)" }} title={`${e.kind}/${e.name}`}>
      <span style={{ color: "var(--color-text-tertiary)" }}>{e.kind}/</span>
      {e.name}
    </span>
  );

  return (
    <>
      <div
        onClick={onToggle}
        style={{
          display: "grid", gridTemplateColumns: gridCols, gap: 8, alignItems: "center",
          padding: "6px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)",
          cursor: "pointer",
          background: expanded ? "var(--color-background-secondary)" : undefined,
        }}
      >
        {/* Type dot */}
        <span
          style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: isWarning ? "var(--color-text-warning)" : "var(--color-text-tertiary)",
          }}
          title={e.type}
        />
        {/* Count */}
        <span style={{ color: e.count > 1 ? "var(--color-text-secondary)" : "var(--color-text-tertiary)" }}>
          {e.count > 1 ? `×${e.count}` : ""}
        </span>
        {/* Age */}
        <span style={{ color: "var(--color-text-tertiary)" }}>
          {e.lastSeenUnix === 0 ? "—" : ago(e.lastSeenUnix)}
        </span>
        {/* Namespace */}
        <span style={{ ...ellipsis, color: "var(--color-text-tertiary)" }} title={e.namespace}>{e.namespace}</span>
        {/* Involved kind/name */}
        <span style={{ fontFamily: "var(--font-mono)", minWidth: 0 }}>
          {involvedCell}
        </span>
        {/* Reason */}
        <span style={{ ...ellipsis, fontWeight: 500, color: isWarning ? "var(--color-text-warning)" : "var(--color-text-secondary)" }} title={e.reason}>{e.reason}</span>
        {/* Message (truncated) */}
        <span style={{ ...ellipsis, color: "var(--color-text-secondary)" }} title={e.message}>{e.message}</span>
      </div>
      {/* Expanded message */}
      {expanded && (
        <div style={{
          padding: "6px 8px 8px 28px",
          borderBottom: "0.5px solid var(--color-border-tertiary)",
          background: "var(--color-background-secondary)",
          fontSize: 11, color: "var(--color-text-primary)",
          lineHeight: 1.5,
          wordBreak: "break-word",
        }}>
          {e.message}
        </div>
      )}
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
      border: on ? "0.5px solid var(--color-text-warning)" : "0.5px solid var(--color-border-tertiary)",
      background: on ? "var(--color-background-warning, transparent)" : "transparent",
      color: on ? "var(--color-text-warning)" : "var(--color-text-tertiary)",
    }}>{children}</button>
  );
}
