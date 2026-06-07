import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import type { ClusterDTO, MetricsDTO } from "../store/fleet";
import { getClusterMetrics } from "../bridge/metrics";
import { stateColor } from "./stateColors";

export function Overview({ c }: { c: ClusterDTO }) {
  const tags = [c.env, c.region, c.provider, c.group].filter(Boolean);
  const metrics = useFleet((s) => s.metrics);
  const loading = useFleet((s) => s.metrics.loading);

  useEffect(() => {
    getClusterMetrics(c.name, false);
    return () => useFleet.getState().clearMetrics();
  }, [c.name]);

  const m: MetricsDTO | null = metrics.cluster === c.name ? metrics.dto : null;

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

      <Section title="Resources">
        <Row label="cpu used"><Usage frac={m?.cpuFraction ?? null} /></Row>
        <Row label="mem used"><Usage frac={m?.memFraction ?? null} /></Row>
        <MonitoringLine dto={m} loading={loading} onRefresh={() => getClusterMetrics(c.name, true)} />
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
      <span style={{ color: "var(--color-text-tertiary)", width: 72 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}

function Usage({ frac }: { frac: number | null }) {
  if (frac == null) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  const pct = Math.max(0, Math.round(frac * 100));
  const color = pct >= 90 ? "var(--color-text-danger)" : pct >= 75 ? "var(--color-text-warning)" : "var(--color-text-success)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span>{pct}%</span>
      <span style={{ width: 80, height: 4, background: "var(--color-background-secondary)", borderRadius: 2, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
      </span>
    </span>
  );
}

function MonitoringLine({ dto, loading, onRefresh }: { dto: MetricsDTO | null; loading: boolean; onRefresh: () => void }) {
  let text: string;
  let color = "var(--color-text-tertiary)";
  if (loading && !dto) {
    text = "monitoring: checking…";
  } else if (!dto) {
    text = "monitoring: —";
  } else if (!dto.available) {
    text = `monitoring unavailable: ${dto.reason || "unknown"}`;
    color = "var(--color-text-warning)";
  } else {
    const where = dto.mode === "explicit-endpoint" ? `endpoint ${dto.source}` : `svc ${dto.source}`;
    const label = dto.mode === "discovered-service" ? "discovered" : dto.mode === "explicit-service-ref" ? "service" : "endpoint";
    text = `monitoring: ${label} · ${where}`;
    if (dto.warning) text += ` ⚠ ${dto.warning}`;
  }
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11, alignItems: "center", marginTop: 2 }}>
      <span style={{ color }}>{text}</span>
      <button
        onClick={onRefresh}
        disabled={loading}
        title="re-probe Prometheus"
        style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, cursor: loading ? "default" : "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)", opacity: loading ? 0.6 : 1 }}
      >
        {loading ? "…" : "refresh"}
      </button>
    </div>
  );
}
