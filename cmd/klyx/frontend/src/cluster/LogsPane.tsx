import { useEffect, useRef, useState, useLayoutEffect, useCallback } from "react";
import { Events } from "@wailsio/runtime";
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize } from "@tabler/icons-react";
import { LogsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import type { ContainerSummaryDTO } from "../store/fleet";
import { parseLine, stripAnsi, splitHighlight } from "./logline";

// TODO(DD5): virtualize line rendering for very large buffers. Currently capped
// at 10000 stored lines / 2000 rendered lines. Roadmap: react-virtual or a
// custom windowed scroller once real-world usage confirms the threshold.

const LOG_BUF_CAP = 10_000;
const DOM_RENDER_CAP = 2_000;

// Expanded pane sits below modals/palette (z-index 1000) and well below toasts (2000).
const EXPAND_Z = 900;

type StreamStatus = "connecting" | "streaming" | "ended" | "error";

interface LogChunkDTO {
  lines: string[];
  eof: boolean;
  error?: string;
}

interface PodRef {
  namespace: string;
  name: string;
  containers: ContainerSummaryDTO[];
}

export function LogsPane({
  cluster,
  pod,
  initialContainer,
  hostedInWindow = false,
  onContainerChange,
}: {
  cluster: string;
  pod: PodRef;
  // initialContainer is used when the containers list is empty (the pop-out
  // window has no pod summary, only the container param). When set with an empty
  // containers list, the picker is replaced by static text and the stream opens
  // on this container directly.
  initialContainer?: string;
  // hostedInWindow hides the expand affordance (fixed-overlay expand is
  // meaningless in a dedicated OS window) and arms a beforeunload best-effort
  // stream close.
  hostedInWindow?: boolean;
  // onContainerChange notifies the host of the active container so a parent (the
  // dock) can carry it into a pop-out. Fired on initial select and every switch.
  onContainerChange?: (container: string) => void;
}) {
  // -- container picker --
  const regular = pod.containers.filter((c) => !c.init);
  const init = pod.containers.filter((c) => c.init);
  const ordered = [...regular, ...init];
  // Default selection: first regular container, else first of any, else the
  // explicit initialContainer (the pop-out case with no containers list).
  const firstRegular = regular[0]?.name ?? ordered[0]?.name ?? initialContainer ?? "";
  // staticContainer: no picker options but an explicit container was provided
  // (pop-out). Render it as static text rather than an empty select.
  const staticContainer = pod.containers.length === 0 && (initialContainer ?? "") !== "";

  const [container, setContainer] = useState(firstRegular);
  const [previous, setPrevious] = useState(false);
  const [tailLines, setTailLines] = useState(500);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  // -- buffer (OUTSIDE zustand) --
  const bufRef = useRef<string[]>([]);
  const droppedRef = useRef(false);
  // version counter: bump once per batch to trigger a re-render
  const [version, setVersion] = useState(0);

  // -- stream state --
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);

  // -- scroll container --
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamIdRef = useRef<string>("");
  const offRef = useRef<(() => void) | null>(null);

  // -- search nav state --
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  // derive which lines to render (last DOM_RENDER_CAP from buffer)
  const buf = bufRef.current;
  const totalLines = buf.length;
  const renderLines = buf.length > DOM_RENDER_CAP ? buf.slice(buf.length - DOM_RENDER_CAP) : buf;
  const truncated = totalLines > DOM_RENDER_CAP;

  // search highlight helpers
  const searchLc = search.toLowerCase();

  // match count + per-line match tracking (index of matches across renderLines)
  const matchLineIndices: number[] = [];
  if (searchLc) {
    for (let i = 0; i < renderLines.length; i++) {
      if (renderLines[i].toLowerCase().includes(searchLc)) matchLineIndices.push(i);
    }
  }
  const matchCount = searchLc
    ? (() => {
        let n = 0;
        for (const l of bufRef.current) if (l.toLowerCase().includes(searchLc)) n++;
        return n;
      })()
    : 0;

  // Clamp activeMatchIdx when matches change
  const clampedActive =
    matchLineIndices.length === 0 ? 0 : activeMatchIdx % matchLineIndices.length;

  // row refs for scrollIntoView
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // -- auto-scroll --
  useLayoutEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [version, follow]);

  // scroll active match into view
  useLayoutEffect(() => {
    if (!searchLc || matchLineIndices.length === 0) return;
    const targetLineIdx = matchLineIndices[clampedActive];
    if (targetLineIdx === undefined) return;
    const el = rowRefs.current[targetLineIdx];
    // guard: jsdom does not implement scrollIntoView
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [clampedActive, searchLc, matchLineIndices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // disable follow on manual scroll-up
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom > 80) setFollow(false);
  }, []);

  // -- stream lifecycle --
  useEffect(() => {
    let stale = false;

    async function open() {
      // close any prior stream
      if (offRef.current) { offRef.current(); offRef.current = null; }
      if (streamIdRef.current) {
        await LogsService.CloseLogStream(streamIdRef.current).catch(() => undefined);
        streamIdRef.current = "";
      }

      // reset buffer
      bufRef.current = [];
      droppedRef.current = false;
      setVersion((v) => v + 1);
      setStatus("connecting");
      setErrorMsg(undefined);

      let result: { streamId: string; error?: string };
      try {
        result = await LogsService.OpenLogStream(
          cluster, pod.namespace, pod.name, container, previous, tailLines,
        );
      } catch (err) {
        if (!stale) {
          setStatus("error");
          setErrorMsg(String(err));
        }
        return;
      }

      if (stale) {
        // unmounted before open completed — close immediately
        if (result.streamId) {
          await LogsService.CloseLogStream(result.streamId).catch(() => undefined);
        }
        return;
      }

      if (result.error || !result.streamId) {
        setStatus("error");
        setErrorMsg(result.error || "failed to open stream");
        return;
      }

      streamIdRef.current = result.streamId;
      setStatus("streaming");

      const eventName = `podlogs:${result.streamId}`;
      const off = Events.On(eventName, (ev: { data: LogChunkDTO }) => {
        if (stale) return;
        const chunk = ev.data;
        if (chunk.lines && chunk.lines.length > 0) {
          const buf = bufRef.current;
          const combined = buf.length + chunk.lines.length;
          if (combined > LOG_BUF_CAP) {
            const drop = combined - LOG_BUF_CAP;
            bufRef.current = [...buf.slice(drop), ...chunk.lines];
            droppedRef.current = true;
          } else {
            bufRef.current = [...buf, ...chunk.lines];
          }
          setVersion((v) => v + 1);
        }
        if (chunk.eof) {
          setStatus("ended");
          if (chunk.error) setErrorMsg(chunk.error);
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
        LogsService.CloseLogStream(sid).catch(() => undefined);
      }
    };
  }, [cluster, pod.namespace, pod.name, container, previous, tailLines]);

  // Notify the host of the active container (initial + every switch) so a parent
  // can carry the selection into a pop-out window.
  useEffect(() => {
    onContainerChange?.(container);
  }, [container]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- pop-out unload: best-effort close of the live stream --
  // When hosted in a dedicated OS window, the React unmount cleanup does NOT run
  // on window close (the webview is torn down without a normal React lifecycle),
  // so wire a beforeunload to close the apiserver stream. This is best-effort:
  // if the window is killed (force-quit) the close may be missed, but the
  // per-stream concurrency cap (oldest evicted on new open) and the app-quit
  // CloseAll() drain in OnShutdown are the backstops that bound leaked streams.
  useEffect(() => {
    if (!hostedInWindow) return;
    const onUnload = () => {
      const sid = streamIdRef.current;
      if (sid) LogsService.CloseLogStream(sid).catch(() => undefined);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [hostedInWindow]);

  // -- Esc: collapse if expanded, stop propagation so panel/list Esc handlers don't fire --
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExpanded(false);
      }
    };
    document.addEventListener("keydown", onKey, true); // capture phase to beat other handlers
    return () => document.removeEventListener("keydown", onKey, true);
  }, [expanded]);

  const clearBuffer = () => {
    bufRef.current = [];
    droppedRef.current = false;
    setVersion((v) => v + 1);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bufRef.current.join("\n"));
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      // clipboard not available (e.g. jsdom) — silently ignore
    }
  };

  const jumpMatch = useCallback((dir: 1 | -1) => {
    if (matchLineIndices.length === 0) return;
    setFollow(false);
    setActiveMatchIdx((prev) => {
      const next = (prev + dir + matchLineIndices.length) % matchLineIndices.length;
      return next;
    });
  }, [matchLineIndices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpMatch(e.shiftKey ? -1 : 1);
    }
  };

  // Reset active match index when search changes
  useEffect(() => { setActiveMatchIdx(0); }, [searchLc]);

  // --------------------------------------------------------------------------
  // Styles
  // --------------------------------------------------------------------------

  const chipStyle = (on: boolean): React.CSSProperties => ({
    fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
    border: on ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
    background: on ? "var(--color-background-info, transparent)" : "transparent",
    color: on ? "var(--color-text-info)" : "var(--color-text-tertiary)",
  });

  const btnStyle: React.CSSProperties = {
    fontSize: 10, padding: "3px 9px", borderRadius: 4, cursor: "pointer",
    border: "0.5px solid var(--color-border-tertiary)",
    background: "var(--color-background-primary)",
    color: "var(--color-text-secondary)",
  };

  const iconBtnStyle: React.CSSProperties = {
    ...btnStyle,
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "3px 5px",
  };

  const selectStyle: React.CSSProperties = {
    fontSize: 11, padding: "3px 6px",
    background: "var(--color-background-primary)",
    color: "var(--color-text-primary)",
    border: "0.5px solid var(--color-border-tertiary)",
    borderRadius: 4,
  };

  // --------------------------------------------------------------------------
  // Controls bar (shared between normal + expanded render)
  // --------------------------------------------------------------------------

  const controlsBar = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
      {/* Container picker — or static text when hosted with no containers list */}
      {staticContainer ? (
        <span
          style={{ fontSize: 11, color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
          aria-label="container"
        >{container}</span>
      ) : (
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          style={selectStyle}
          aria-label="container"
        >
          {regular.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          {init.map((c) => <option key={c.name} value={c.name}>init: {c.name}</option>)}
        </select>
      )}

      {/* Tail lines */}
      <select
        value={tailLines}
        onChange={(e) => setTailLines(Number(e.target.value))}
        style={selectStyle}
        aria-label="tail lines"
      >
        <option value={100}>100 lines</option>
        <option value={500}>500 lines</option>
        <option value={1000}>1000 lines</option>
        <option value={5000}>5000 lines</option>
      </select>

      {/* Toggles */}
      <button style={chipStyle(previous)} onClick={() => setPrevious((p) => !p)}>previous</button>
      <button
        style={chipStyle(follow)}
        onClick={() => {
          setFollow((f) => {
            if (!f && scrollRef.current) {
              setTimeout(() => {
                if (scrollRef.current)
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }, 0);
            }
            return !f;
          });
        }}
      >follow</button>
      <button style={chipStyle(wrap)} onClick={() => setWrap((w) => !w)}>wrap</button>

      {/* Search */}
      <input
        ref={searchInputRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleSearchKey}
        placeholder="search"
        style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: 120 }}
        aria-label="search logs"
      />
      {search && (
        <>
          <span style={{ fontSize: 10, color: matchCount > 0 ? "var(--color-text-info)" : "var(--color-text-tertiary)" }}>
            {matchLineIndices.length > 0
              ? `${clampedActive + 1}/${matchCount}`
              : `0 matches`}
          </span>
          {matchLineIndices.length > 0 && (
            <>
              <button style={btnStyle} onClick={() => jumpMatch(-1)} title="previous match (Shift+Enter)">↑</button>
              <button style={btnStyle} onClick={() => jumpMatch(1)} title="next match (Enter)">↓</button>
            </>
          )}
        </>
      )}

      <button onClick={clearBuffer} style={btnStyle}>clear</button>
      <button
        onClick={() => void handleCopy()}
        style={btnStyle}
        aria-label="copy logs"
      >
        {copyState === "copied" ? "copied!" : "copy"}
      </button>

      {/* Expand / collapse — hidden in a pop-out window (fixed-overlay expand is
          meaningless when the pane already owns the whole window). */}
      {!hostedInWindow && (
        <button
          style={iconBtnStyle}
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "collapse logs" : "expand logs"}
          title={expanded ? "collapse (Esc)" : "expand"}
        >
          {expanded
            ? <IconArrowsDiagonalMinimize size={13} stroke={1.5} />
            : <IconArrowsDiagonal size={13} stroke={1.5} />}
        </button>
      )}

      {/* Status (right-aligned) */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, fontSize: 10 }}>
        {status === "streaming" && (
          <>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-text-success)", display: "inline-block" }} />
            <span style={{ color: "var(--color-text-success)" }}>streaming</span>
          </>
        )}
        {status === "connecting" && <span style={{ color: "var(--color-text-tertiary)" }}>connecting…</span>}
        {status === "ended" && !errorMsg && <span style={{ color: "var(--color-text-tertiary)" }}>ended</span>}
        {status === "ended" && errorMsg && <span style={{ color: "var(--color-text-danger)" }} title={errorMsg}>ended: {errorMsg}</span>}
        {status === "error" && <span style={{ color: "var(--color-text-danger)" }} title={errorMsg}>error: {errorMsg}</span>}
      </div>
    </div>
  );

  // --------------------------------------------------------------------------
  // Log viewport (shared)
  // --------------------------------------------------------------------------

  const logViewport = (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        flex: 1, minHeight: 0,
        overflowY: "auto",
        overflowX: wrap ? "hidden" : "auto",
        background: "var(--color-background-secondary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: 4,
        padding: "6px 8px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.55,
        color: "var(--color-text-secondary)",
      }}
    >
      {droppedRef.current && (
        <div style={{ color: "var(--color-text-tertiary)", fontSize: 10, marginBottom: 2, userSelect: "none" }}>
          · older lines dropped (buffer capped at {LOG_BUF_CAP})
        </div>
      )}
      {truncated && (
        <div style={{ color: "var(--color-text-tertiary)", fontSize: 10, marginBottom: 2, userSelect: "none" }}>
          · showing last {DOM_RENDER_CAP} of {totalLines} lines
        </div>
      )}

      {renderLines.map((line, i) => {
        const isActiveMatch = searchLc
          ? matchLineIndices[clampedActive] === i
          : false;
        return (
          <LogLine
            key={i}
            ref={(el) => { rowRefs.current[i] = el; }}
            line={line}
            search={searchLc}
            wrap={wrap}
            activeMatch={isActiveMatch}
          />
        );
      })}
    </div>
  );

  // --------------------------------------------------------------------------
  // Expanded layout
  // --------------------------------------------------------------------------

  if (expanded) {
    return (
      <div
        data-testid="logs-pane-expanded"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: EXPAND_Z,
          background: "var(--color-background-primary)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Expanded header: ns/pod · container + controls */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-text-secondary)",
            whiteSpace: "nowrap",
            paddingTop: 4,
          }}>
            <span style={{ color: "var(--color-text-tertiary)" }}>{pod.namespace}</span>
            /
            <span style={{ fontWeight: 500 }}>{pod.name}</span>
            {" · "}
            <span style={{ color: "var(--color-text-tertiary)" }}>{container}</span>
          </span>
          <div style={{ flex: 1 }}>
            {controlsBar}
          </div>
        </div>
        {logViewport}
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Normal (inline) layout
  // --------------------------------------------------------------------------

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ marginBottom: 8 }}>
        {controlsBar}
      </div>
      {logViewport}
    </div>
  );
}

// --------------------------------------------------------------------------
// LogLine component
// --------------------------------------------------------------------------

import React from "react";

const LogLine = React.forwardRef<
  HTMLDivElement,
  { line: string; search: string; wrap: boolean; activeMatch: boolean }
>(function LogLine({ line, search, wrap, activeMatch }, ref) {
  const parsed = parseLine(stripAnsi(line));

  const levelColor = ((): string => {
    switch (parsed.level) {
      case "error": return "var(--color-text-danger)";
      case "warn":  return "var(--color-text-warning)";
      case "debug": return "var(--color-text-tertiary)";
      default:      return "var(--color-text-secondary)";
    }
  })();

  const rowStyle: React.CSSProperties = {
    whiteSpace: wrap ? "pre-wrap" : "pre",
    wordBreak: wrap ? "break-all" : "normal",
    color: levelColor,
    paddingTop: 2,
    paddingBottom: 2,
    userSelect: "text",
    background: activeMatch ? "var(--color-background-secondary)" : undefined,
    // In no-wrap mode the row must NOT scroll itself (a per-line overflow gives
    // every long line its own macOS overlay scrollbar - dark bars across the
    // text). The row grows to its content width and the VIEWPORT provides the
    // single horizontal scrollbar; minWidth keeps short rows' match-highlight
    // background spanning the full scroll width.
    width: wrap ? undefined : "max-content",
    minWidth: wrap ? undefined : "100%",
  };

  const text = parsed.text;
  const dimLen = parsed.dimPrefixLen;

  // Split text into prefix and body, then apply search highlights within each.
  const prefix = dimLen > 0 ? text.slice(0, dimLen) : "";
  const body = dimLen > 0 ? text.slice(dimLen) : text;

  if (!search) {
    return (
      <div ref={ref} style={rowStyle}>
        {prefix && <span style={{ color: "var(--color-text-tertiary)" }}>{prefix || "​"}</span>}
        {body || (!prefix ? "​" : "")}
      </div>
    );
  }

  return (
    <div ref={ref} style={rowStyle}>
      {prefix && (
        <span style={{ color: "var(--color-text-tertiary)" }}>
          {renderHighlighted(prefix, search)}
        </span>
      )}
      {renderHighlighted(body, search)}
    </div>
  );
});

function renderHighlighted(text: string, searchLc: string): React.ReactNode {
  if (!text) return null;
  const segments = splitHighlight(text, searchLc);
  return segments.map((seg, i) =>
    seg.match ? (
      <mark
        key={i}
        style={{ background: "var(--color-text-warning)", color: "var(--color-background-primary)", borderRadius: 2 }}
      >
        {seg.value}
      </mark>
    ) : (
      <React.Fragment key={i}>{seg.value}</React.Fragment>
    ),
  );
}
