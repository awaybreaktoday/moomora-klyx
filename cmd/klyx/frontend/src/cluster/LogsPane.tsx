import { useEffect, useRef, useState, useLayoutEffect, useCallback } from "react";
import { Events } from "@wailsio/runtime";
import { LogsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import type { ContainerSummaryDTO } from "../store/fleet";

// TODO(DD5): virtualize line rendering for very large buffers. Currently capped
// at 10000 stored lines / 2000 rendered lines. Roadmap: react-virtual or a
// custom windowed scroller once real-world usage confirms the threshold.

const LOG_BUF_CAP = 10_000;
const DOM_RENDER_CAP = 2_000;

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

export function LogsPane({ cluster, pod }: { cluster: string; pod: PodRef }) {
  // -- container picker --
  const regular = pod.containers.filter((c) => !c.init);
  const init = pod.containers.filter((c) => c.init);
  const ordered = [...regular, ...init];
  const firstRegular = regular[0]?.name ?? ordered[0]?.name ?? "";

  const [container, setContainer] = useState(firstRegular);
  const [previous, setPrevious] = useState(false);
  const [tailLines, setTailLines] = useState(500);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [search, setSearch] = useState("");

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

  // derive which lines to render (last DOM_RENDER_CAP from buffer)
  const buf = bufRef.current;
  const totalLines = buf.length;
  const renderLines = buf.length > DOM_RENDER_CAP ? buf.slice(buf.length - DOM_RENDER_CAP) : buf;
  const truncated = totalLines > DOM_RENDER_CAP;

  // search highlight helpers
  const searchLc = search.toLowerCase();
  const countMatches = useCallback(
    (lines: string[]) => {
      if (!searchLc) return 0;
      let n = 0;
      for (const l of lines) if (l.toLowerCase().includes(searchLc)) n++;
      return n;
    },
    [searchLc],
  );
  const matchCount = searchLc ? countMatches(bufRef.current) : 0;

  // -- auto-scroll --
  useLayoutEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [version, follow]);

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

  const clearBuffer = () => {
    bufRef.current = [];
    droppedRef.current = false;
    setVersion((v) => v + 1);
  };

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

  const selectStyle: React.CSSProperties = {
    fontSize: 11, padding: "3px 6px",
    background: "var(--color-background-primary)",
    color: "var(--color-text-primary)",
    border: "0.5px solid var(--color-border-tertiary)",
    borderRadius: 4,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>

      {/* Controls bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap", flexShrink: 0 }}>
        {/* Container picker */}
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          style={selectStyle}
          aria-label="container"
        >
          {regular.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          {init.map((c) => <option key={c.name} value={c.name}>init: {c.name}</option>)}
        </select>

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
                // re-enabling: snap to bottom immediately
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
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search"
          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: 120 }}
          aria-label="search logs"
        />
        {search && (
          <span style={{ fontSize: 10, color: matchCount > 0 ? "var(--color-text-info)" : "var(--color-text-tertiary)" }}>
            {matchCount} match{matchCount !== 1 ? "es" : ""}
          </span>
        )}

        <button onClick={clearBuffer} style={btnStyle}>clear</button>

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

      {/* Log viewport */}
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
          color: "var(--color-text-primary)",
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

        {renderLines.map((line, i) => (
          <LogLine key={i} line={line} search={searchLc} wrap={wrap} />
        ))}
      </div>
    </div>
  );
}

function LogLine({ line, search, wrap }: { line: string; search: string; wrap: boolean }) {
  if (!search || !line.toLowerCase().includes(search)) {
    return (
      <div style={{ whiteSpace: wrap ? "pre-wrap" : "pre", wordBreak: wrap ? "break-all" : "normal" }}>
        {line || "​"}
      </div>
    );
  }

  // highlight all occurrences
  const parts: React.ReactNode[] = [];
  let rest = line;
  let cursor = 0;
  while (true) {
    const idx = rest.toLowerCase().indexOf(search);
    if (idx === -1) {
      parts.push(rest);
      break;
    }
    if (idx > 0) parts.push(rest.slice(0, idx));
    parts.push(
      <mark key={cursor} style={{ background: "var(--color-text-warning)", color: "var(--color-background-primary)", borderRadius: 2 }}>
        {rest.slice(idx, idx + search.length)}
      </mark>,
    );
    rest = rest.slice(idx + search.length);
    cursor++;
  }

  return (
    <div style={{ whiteSpace: wrap ? "pre-wrap" : "pre", wordBreak: wrap ? "break-all" : "normal" }}>
      {parts}
    </div>
  );
}
