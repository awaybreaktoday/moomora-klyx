import { useEffect, useRef } from "react";
import { useFleet } from "../store/fleet";

const AUTO_DISMISS_MS = 6000;

/**
 * ActionToast — global fixed-position action feedback toast.
 *
 * Mount once inside AppShell. Reads actionStatus from the fleet store and
 * auto-dismisses after 6 s. Clicking the toast also dismisses it.
 *
 * All per-view toast blocks (GitOps, WorkloadsView, PodsView panel,
 * NodesView) have been removed in favour of this singleton.
 */
export function ActionToast() {
  const actionStatus = useFleet((s) => s.actionStatus);
  const clearActionStatus = useFleet((s) => s.clearActionStatus);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!actionStatus) return;
    timerRef.current = setTimeout(() => {
      clearActionStatus();
      timerRef.current = null;
    }, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [actionStatus, clearActionStatus]);

  if (!actionStatus) return null;

  return (
    <div
      role="status"
      onClick={clearActionStatus}
      style={{
        position: "fixed",
        bottom: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        padding: "8px 16px",
        borderRadius: 6,
        fontSize: 12,
        fontFamily: "var(--font-sans, sans-serif)",
        cursor: "pointer",
        border: "0.5px solid var(--color-border-secondary)",
        background: "var(--color-background-primary)",
        color: actionStatus.kind === "error"
          ? "var(--color-text-danger)"
          : "var(--color-text-success)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        maxWidth: 480,
        wordBreak: "break-word",
        textAlign: "center",
      }}
    >
      {actionStatus.message}
    </div>
  );
}
