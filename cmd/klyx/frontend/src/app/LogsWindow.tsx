import { LogsPane } from "../cluster/LogsPane";
import { TopBar } from "../chrome/TopBar";

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
  // mode=workload pops an AGGREGATE tail: name/kind identify the workload and
  // the pane opens OpenWorkloadLogStream instead of a single-pod stream.
  const isWorkload = q.get("mode") === "workload";
  const name = (isWorkload ? q.get("name") : q.get("pod")) ?? "";
  const kind = q.get("kind") ?? "";
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
      }}
    >
      {/* The same TopBar as the main window: traffic lights get their own clean
          draggable strip (theme toggle included; the forwards indicator renders
          nothing here because the popout never installs that subscription). */}
      <TopBar />

      {/* Identity line below the bar - the popout's equivalent of the main
          window's breadcrumb zone. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0, padding: "10px 12px 0" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500 }}>
          <span style={{ color: "var(--color-text-tertiary)" }}>{namespace}</span>/{name}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{cluster}</span>
      </div>

      {/* LogsPane fills the rest. containers:[] + initialContainer drives the
          static-container path (the window has no pod summary). */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "8px 12px 12px" }}>
        <LogsPane
          cluster={cluster}
          pod={{ namespace, name, containers: [] }}
          workload={isWorkload ? { kind, name } : undefined}
          initialContainer={container}
          hostedInWindow
        />
      </div>
    </div>
  );
}
