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
};

export function policyTooltip(p: PolicyRefDTO): string {
  const id = `${p.kind} ${p.namespace}/${p.name}`;
  if (p.details.length === 0) return id;
  return [id, ...p.details.slice(0, 4).map((d) => `${d.key}: ${d.value}`)].join("\n");
}

export function PolicyChip({ p }: { p: PolicyRefDTO }) {
  const abbr = ABBREV[p.kind] ?? p.kind;
  const c = COLOUR[p.kind] ?? { fg: "var(--color-text-secondary)", bg: "var(--color-background-secondary)" };
  return (
    <span
      title={policyTooltip(p)}
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
        cursor: "default",
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <b style={{ fontWeight: 700 }}>{abbr}</b>
      {p.summary && <span>{p.summary}</span>}
      {p.inferred && <span style={{ opacity: 0.7 }}>~</span>}
    </span>
  );
}
