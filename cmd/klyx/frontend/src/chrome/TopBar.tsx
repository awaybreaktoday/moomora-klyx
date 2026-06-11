import { useState, useRef, useEffect } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { useFleet } from "../store/fleet";
import { stopForward, stopAllForwards } from "../bridge/forwards";

// Wails v3 window-drag regions: the bar is draggable, interactive children opt out.
const drag = { "--wails-draggable": "drag" } as React.CSSProperties;
const noDrag = { "--wails-draggable": "no-drag" } as React.CSSProperties;

// TopBar is the full-width title bar: macOS traffic lights sit on its left (the
// padding clears them), the forwards indicator + theme toggle on its right, and
// the empty middle drags the window. The breadcrumb lives in the content Header.
export function TopBar() {
  return (
    <div
      style={{
        ...drag,
        display: "flex",
        alignItems: "center",
        height: 40,
        flexShrink: 0,
        paddingLeft: 84,
        paddingRight: 12,
        background: "var(--color-background-secondary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
      }}
    >
      <div style={{ flex: 1 }} />
      <div style={{ ...noDrag, display: "flex", alignItems: "center", gap: 8 }}>
        <ForwardsIndicator />
        <ThemeToggle />
      </div>
    </div>
  );
}

// ForwardsIndicator shows a compact "⇄ N" chip when any port-forwards exist.
// Clicking it opens a dropdown panel listing every forward with a per-row stop
// button and a "stop all". Broken rows render warning-coloured.
function ForwardsIndicator() {
  const forwards = useFleet((s) => s.forwards);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (forwards.length === 0) return null;

  const anyBroken = forwards.some((f) => f.status === "broken");

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="active port-forwards"
        data-testid="forwards-chip"
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontFamily: "var(--font-mono)", fontSize: 11,
          padding: "3px 9px", borderRadius: 11, cursor: "pointer",
          border: `0.5px solid ${anyBroken ? "var(--color-text-warning)" : "var(--color-text-info)"}`,
          background: "transparent",
          color: anyBroken ? "var(--color-text-warning)" : "var(--color-text-info)",
        }}
      >
        <span aria-hidden>⇄</span>
        <span>{forwards.length}</span>
      </button>

      {open && (
        <div
          data-testid="forwards-panel"
          style={{
            position: "absolute", top: 30, right: 0, zIndex: 50,
            width: 340, maxHeight: 320, overflowY: "auto",
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: 6, boxShadow: "0 6px 24px rgba(0,0,0,0.28)",
            padding: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", padding: "4px 6px 6px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", flex: 1 }}>
              port-forwards
            </span>
            <button
              onClick={() => { useFleet.getState().openForwards(); setOpen(false); }}
              data-testid="forwards-view-all"
              style={{ fontSize: 10, padding: "2px 8px", marginRight: 4, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" }}
            >view all</button>
            <button
              onClick={() => void stopAllForwards()}
              data-testid="forwards-stop-all"
              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" }}
            >stop all</button>
          </div>

          {forwards.map((f) => {
            const broken = f.status === "broken";
            return (
              <div
                key={f.id}
                data-testid={`forward-row-${f.id}`}
                style={{
                  display: "grid", gridTemplateColumns: "8px 1fr auto", gap: 8, alignItems: "center",
                  padding: "6px 6px", fontFamily: "var(--font-mono)", fontSize: 11,
                  borderBottom: "0.5px solid var(--color-border-tertiary)",
                  color: broken ? "var(--color-text-warning)" : "var(--color-text-primary)",
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: broken ? "var(--color-text-warning)" : "var(--color-text-success)" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`${f.cluster} ${f.namespace}/${f.targetName}`}>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{f.cluster}</span>{" "}
                  {f.namespace}/{f.targetName}{" "}
                  <span style={{ color: broken ? "var(--color-text-warning)" : "var(--color-text-info)" }}>
                    :{f.localPort}→:{f.targetPort}
                  </span>
                  {broken && <span style={{ marginLeft: 4, fontSize: 9 }}>broken</span>}
                </span>
                <button
                  onClick={() => void stopForward(f.id)}
                  data-testid={`forward-stop-${f.id}`}
                  style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" }}
                >stop</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
