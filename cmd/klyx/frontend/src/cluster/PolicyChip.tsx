import { useState } from "react";
import type { PolicyRefDTO } from "../store/fleet";

const ABBREV: Record<string, string> = {
  ClientTrafficPolicy: "CTP",
  BackendTrafficPolicy: "BTP",
  SecurityPolicy: "SP",
  EnvoyExtensionPolicy: "EEP",
  BackendTLSPolicy: "BTLS",
  CiliumNetworkPolicy: "CNP",
  CiliumClusterwideNetworkPolicy: "CCNP",
};

const COLOUR: Record<string, { fg: string; bg: string }> = {
  ClientTrafficPolicy: { fg: "#58a6ff", bg: "rgba(56,139,253,.16)" },
  BackendTrafficPolicy: { fg: "#a371f7", bg: "rgba(163,113,247,.16)" },
  SecurityPolicy: { fg: "#3fb950", bg: "rgba(46,160,67,.16)" },
  EnvoyExtensionPolicy: { fg: "#d29922", bg: "rgba(210,153,34,.16)" },
  BackendTLSPolicy: { fg: "#ec6547", bg: "rgba(236,101,71,.16)" },
  CiliumNetworkPolicy: { fg: "#8b949e", bg: "rgba(139,148,158,.10)" },
  CiliumClusterwideNetworkPolicy: { fg: "#8b949e", bg: "rgba(139,148,158,.10)" },
};

// The chip summary is feature names joined by " + " (the delimiter never appears
// inside a feature name). Show at most the first two features, then "+N" for the
// rest, so a busy policy collapses to e.g. "retries + timeout +1" instead of an
// ellipsis-clipped wall.
export function chipSummary(summary: string): string {
  if (!summary) return "";
  const feats = summary.split(" + ");
  if (feats.length <= 2) return feats.join(" + ");
  return `${feats.slice(0, 2).join(" + ")} +${feats.length - 2}`;
}

export function PolicyChip({ p }: { p: PolicyRefDTO }) {
  const abbr = ABBREV[p.kind] ?? p.kind;
  const c = COLOUR[p.kind] ?? { fg: "var(--color-text-secondary)", bg: "var(--color-background-secondary)" };
  const [hover, setHover] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 8,
          padding: "1px 5px",
          borderRadius: 3,
          fontFamily: "var(--font-mono)",
          color: c.fg,
          background: c.bg,
          border: p.inferred ? `0.5px dashed ${c.fg}` : "0.5px solid transparent",
          cursor: "default",
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <b style={{ fontWeight: 700 }}>{abbr}</b>
        {p.summary && <span>{chipSummary(p.summary)}</span>}
        {p.inferred && <span style={{ opacity: 0.7 }}>~</span>}
      </span>
      {hover && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: 4,
            zIndex: 50,
            minWidth: 260,
            maxWidth: 360,
            padding: "8px 10px",
            borderRadius: 6,
            border: "0.5px solid var(--color-border-tertiary)",
            background: "var(--color-background-tertiary)",
            color: "var(--color-text-primary)",
            fontSize: 10,
            lineHeight: 1.5,
            boxShadow: "0 4px 14px rgba(0,0,0,.35)",
            pointerEvents: "none",
          }}
        >
          {p.inferred && (
            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 4, fontStyle: "italic" }}>
              inferred: matched by Service selector, not a Gateway API attachment{p.match ? ` · via: ${p.match}` : ""}
            </div>
          )}
          <div style={{ fontWeight: 600, marginBottom: p.details.length ? 4 : 0 }}>
            {p.kind} {p.namespace}/{p.name}
          </div>
          {p.details.map((d, i) => (
            <div key={i} style={{ color: "var(--color-text-secondary)" }}>
              {d.key}: {d.value}
            </div>
          ))}
        </span>
      )}
    </span>
  );
}
