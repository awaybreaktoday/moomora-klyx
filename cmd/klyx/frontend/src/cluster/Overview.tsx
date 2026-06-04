import type { ClusterDTO } from "../store/fleet";

const stateColor: Record<string, string> = {
  Synced: "var(--color-text-success)",
  Degraded: "var(--color-text-warning)",
  Stale: "var(--color-text-warning)",
  Connecting: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unconnected: "var(--color-text-tertiary)",
};

export function Overview({ c }: { c: ClusterDTO }) {
  const tags = [c.env, c.region, c.provider, c.group].filter(Boolean);
  return (
    <div style={{ padding: "16px 20px", maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor[c.state] ?? "var(--color-text-tertiary)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 15 }}>{c.name}</span>
        {c.version && <Badge>{c.version}</Badge>}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        {tags.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      <Section title="Health">
        <Row label="state"><span style={{ color: stateColor[c.state] }}>{c.state}</span></Row>
        {c.reason && <Row label="reason">{c.reason}</Row>}
        <Row label="age">{c.ageSeconds}s ago</Row>
      </Section>

      <Section title="Capacity">
        <Row label="nodes">{c.nodesReady}/{c.nodesTotal}</Row>
        <Row label="pods">{c.pods}</Row>
      </Section>

      <Section title="Capabilities">
        <Row label="gitops">{c.gitopsTier}{c.gitopsReason ? ` — ${c.gitopsReason}` : ""}</Row>
        <Row label="network">{c.networkTier}{c.networkReason ? ` — ${c.networkReason}` : ""}</Row>
      </Section>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "1px 6px", borderRadius: 4 }}>{children}</span>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--color-text-tertiary)", width: 64 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}
