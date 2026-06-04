import type { ClusterDTO } from "../store/fleet";

const stateColor: Record<string, string> = {
  Synced: "var(--color-text-success)",
  Degraded: "var(--color-text-warning)",
  Stale: "var(--color-text-warning)",
  Connecting: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unconnected: "var(--color-text-tertiary)",
};

export function ClusterCard({ c }: { c: ClusterDTO }) {
  return (
    <div style={{
      background: "var(--color-background-primary)",
      border: "0.5px solid var(--color-border-tertiary)",
      borderRadius: "var(--border-radius-md)",
      padding: "10px 12px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor[c.state] ?? "var(--color-text-tertiary)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 12 }}>{c.name}</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8, fontSize: 10 }}>
        {c.env && <Badge>{c.env}</Badge>}
        {c.region && <Badge>{c.region}</Badge>}
        {c.version && <Badge>{c.version}</Badge>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, fontSize: 11, marginBottom: 8 }}>
        <Stat label="nodes" value={`${c.nodesReady}/${c.nodesTotal}`} />
        <Stat label="pods" value={`${c.pods}`} />
        <Stat label="gitops" value={c.gitopsTier} />
        <Stat label="network" value={c.networkTier} />
      </div>
      <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 6, fontSize: 10, color: stateColor[c.state] }}>
        {c.state}{c.reason ? ` — ${c.reason}` : ""}
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", padding: "1px 6px", borderRadius: 4 }}>{children}</span>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div><span style={{ color: "var(--color-text-tertiary)" }}>{label}</span> <span style={{ fontWeight: 500 }}>{value}</span></div>;
}
