import { useState } from "react";
import { startForward } from "../bridge/forwards";

const btn: React.CSSProperties = {
  fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)",
};

// ForwardPopover is a tiny inline form (mirrors ScalePopover from DD3-T1): a
// target-port input (prefilled when known), a local-port input (placeholder
// "auto" => ephemeral), and a start button. On start it dispatches the bridge
// call and closes; the resulting localhost port surfaces via the action toast.
export function ForwardPopover({
  cluster, namespace, kind, name, prefillTargetPort, onClose,
}: {
  cluster: string;
  namespace: string;
  kind: "Pod" | "Service";
  name: string;
  prefillTargetPort?: number;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(prefillTargetPort ? String(prefillTargetPort) : "");
  const [local, setLocal] = useState("");

  const tp = parseInt(target, 10);
  const lp = local.trim() === "" ? 0 : parseInt(local, 10);
  const targetValid = !Number.isNaN(tp) && tp > 0 && tp <= 65535;
  const localValid = local.trim() === "" || (!Number.isNaN(lp) && lp >= 0 && lp <= 65535);
  const valid = targetValid && localValid;

  const submit = () => {
    if (!valid) return;
    void startForward(cluster, namespace, kind, name, lp, tp);
    onClose();
  };

  return (
    <span
      onClick={(e) => e.stopPropagation()}
      data-testid="forward-popover"
      style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, padding: "2px 6px", background: "var(--color-background-primary)" }}
    >
      <input
        aria-label="target port"
        type="number"
        min={1}
        max={65535}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") onClose(); }}
        placeholder="port"
        autoFocus
        style={inputStyle}
      />
      <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>→</span>
      <input
        aria-label="local port"
        type="number"
        min={0}
        max={65535}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") onClose(); }}
        placeholder="auto"
        style={inputStyle}
      />
      <button onClick={submit} disabled={!valid} data-testid="forward-start" style={{ ...btn, padding: "2px 7px", opacity: valid ? 1 : 0.4, cursor: valid ? "pointer" : "not-allowed" }}>forward</button>
      <button onClick={onClose} style={{ ...btn, padding: "2px 6px" }}>✕</button>
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: 56, fontSize: 11, padding: "2px 4px", fontFamily: "var(--font-mono)",
  background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 3, color: "var(--color-text-primary)",
};
