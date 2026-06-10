import { LogsPane } from "../cluster/LogsPane";

// LogsWindow is the root rendered in a pop-out log window (URL flag logswin=1).
// It boots NONE of the normal app: no fleet subscriptions, no sidebar, no
// command palette. It reads the target from the query string and hosts a single
// LogsPane filling the window. The OS window provides the close button, so there
// is no in-app close affordance.
//
// params defaults to window.location.search but is injectable for tests.
export function LogsWindow({ params }: { params?: URLSearchParams }) {
  const q = params ?? new URLSearchParams(window.location.search);
  const cluster = q.get("cluster") ?? "";
  const namespace = q.get("ns") ?? "";
  const name = q.get("pod") ?? "";
  const container = q.get("container") ?? "";

  return (
    <div
      data-testid="logs-window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        boxSizing: "border-box",
        background: "var(--color-background-primary)",
        color: "var(--color-text-primary)",
        padding: 12,
        gap: 8,
      }}
    >
      {/* Slim header: mono ns/pod + muted cluster name. No close button. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500 }}>
          <span style={{ color: "var(--color-text-tertiary)" }}>{namespace}</span>/{name}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{cluster}</span>
      </div>

      {/* LogsPane fills the rest. containers:[] + initialContainer drives the
          static-container path (the window has no pod summary). */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <LogsPane
          cluster={cluster}
          pod={{ namespace, name, containers: [] }}
          initialContainer={container}
          hostedInWindow
        />
      </div>
    </div>
  );
}
