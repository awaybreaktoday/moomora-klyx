import { useEffect, useState } from "react";
import { useFleet } from "../store/fleet";
import type { ClusterDTO, MetricsDTO } from "../store/fleet";
import { getClusterMetrics, getClusterSparklines } from "../bridge/metrics";
import type { SparklinesDTO } from "../bridge/metrics";
import { fetchOverviewSummary } from "../bridge/overview";
import { Sparkline } from "../chrome/Sparkline";
import { stateColor } from "./stateColors";

export function Overview({ c }: { c: ClusterDTO }) {
  const tags = [c.env, c.region, c.provider, c.group].filter(Boolean);
  const metrics = useFleet((s) => s.metrics);
  const loading = useFleet((s) => s.metrics.loading);
  const summary = useFleet((s) => s.overviewSummary);
  // 30m cluster utilisation sparklines — fetched once per mount, local state.
  const [spark, setSpark] = useState<SparklinesDTO | null>(null);

  useEffect(() => {
    getClusterMetrics(c.name, false);
    fetchOverviewSummary(c.name);
    let cancelled = false;
    getClusterSparklines(c.name).then((dto) => {
      if (!cancelled) setSpark(dto);
    });
    return () => {
      cancelled = true;
      setSpark(null);
      useFleet.getState().clearMetrics();
      useFleet.getState().clearOverviewSummary();
    };
  }, [c.name]);

  const m: MetricsDTO | null = metrics.cluster === c.name ? metrics.dto : null;
  const s = summary.cluster === c.name ? summary : null;

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

      <AttentionStrip summary={s} loading={summary.loading && summary.cluster === c.name} />

      <Section title="Health">
        <Row label="state"><span style={{ color: stateColor[c.state] }}>{c.state}</span></Row>
        {c.reason && <Row label="reason">{c.reason}</Row>}
        <Row label="age">{c.ageSeconds}s ago</Row>
      </Section>

      <Section title="Capacity">
        <Row label="nodes">{c.nodesReady}/{c.nodesTotal}</Row>
        <Row label="pods">{c.pods}</Row>
        {s && s.namespaces !== null && <Row label="namespaces">{s.namespaces}</Row>}
      </Section>

      <Section title="Resources">
        <Row label="cpu used">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <Usage frac={m?.cpuFraction ?? null} />
            {spark?.available && <Sparkline points={spark.cpu} height={16} width={90} />}
          </span>
        </Row>
        <Row label="mem used">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <Usage frac={m?.memFraction ?? null} />
            {spark?.available && <Sparkline points={spark.mem} height={16} width={90} />}
          </span>
        </Row>
        <MonitoringLine dto={m} loading={loading} onRefresh={() => getClusterMetrics(c.name, true)} />
      </Section>

      <Section title="Capabilities">
        <Row label="gitops">{c.gitopsTier}{c.gitopsReason ? ` — ${c.gitopsReason}` : ""}</Row>
        <Row label="network">{c.networkTier}{c.networkReason ? ` — ${c.networkReason}` : ""}</Row>
      </Section>
    </div>
  );
}

// ---- Attention strip -----------------------------------------------------------

type SummaryForStrip = {
  unhealthyWorkloads: number | null;
  podsNotReady: number | null;
  warningEvents: number | null;
  nodeProblems: number | null;
  helmAvailable: boolean;
  failedReleases: number | null;
  flux: { present: boolean; notReady: number; suspended: number } | null;
};

function AttentionStrip({ summary, loading }: { summary: SummaryForStrip | null; loading: boolean }) {
  const nav = useFleet.getState();

  function goWorkloads() {
    nav.setSection("workloads");
    nav.setWorkloadsNeedsAttention(true);
  }
  function goPods() {
    nav.setSection("pods");
    nav.setPodsNeedsAttention(true);
  }
  function goEvents() {
    nav.setSection("events");
    nav.setWarningsOnly(true);
  }
  function goNodes() {
    nav.setSection("nodes");
  }
  function goHelm() {
    nav.setSection("helm");
  }
  function goGitOps() {
    nav.setSection("gitops");
  }

  const fluxTileTitle = (() => {
    const suspended = summary?.flux?.suspended ?? 0;
    return suspended > 0 ? `${suspended} suspended` : undefined;
  })();

  const tiles: Array<{
    key: string;
    count: number | null;
    label: string;
    variant: "danger" | "warning";
    onClick: () => void;
    hidden?: boolean;
    title?: string;
  }> = [
    { key: "workloads", count: summary?.unhealthyWorkloads ?? null, label: "unhealthy workloads", variant: "danger", onClick: goWorkloads },
    { key: "pods", count: summary?.podsNotReady ?? null, label: "pods not ready", variant: "danger", onClick: goPods },
    { key: "events", count: summary?.warningEvents ?? null, label: "warning events", variant: "warning", onClick: goEvents },
    { key: "nodes", count: summary?.nodeProblems ?? null, label: "node problems", variant: "danger", onClick: goNodes },
    { key: "helm", count: summary?.failedReleases ?? null, label: "failed releases", variant: "danger", onClick: goHelm, hidden: !(summary?.helmAvailable ?? false) },
    { key: "flux", count: summary?.flux != null ? summary.flux.notReady : null, label: "flux not ready", variant: "danger", onClick: goGitOps, hidden: !(summary?.flux?.present ?? false), title: fluxTileTitle },
  ];

  const visibleTiles = tiles.filter((t) => !t.hidden);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
      {visibleTiles.map((tile) => (
        <StatTile
          key={tile.key}
          count={loading ? null : tile.count}
          label={tile.label}
          variant={tile.variant}
          onClick={tile.onClick}
          title={tile.title}
        />
      ))}
    </div>
  );
}

function StatTile({
  count,
  label,
  variant,
  onClick,
  title: tileTitle,
}: {
  count: number | null;
  label: string;
  variant: "danger" | "warning";
  onClick: () => void;
  title?: string;
}) {
  // count === null means still loading OR fetch failed for this tile.
  const isLoading = count === null;
  const isAlert = !isLoading && count > 0;
  const countColor = isLoading
    ? "var(--color-text-tertiary)"
    : isAlert
      ? variant === "danger"
        ? "var(--color-text-danger)"
        : "var(--color-text-warning)"
      : "var(--color-text-tertiary)";

  return (
    <button
      onClick={onClick}
      title={tileTitle ?? (count === null ? "failed to load" : undefined)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 2,
        padding: "6px 10px",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: 6,
        background: "var(--color-background-primary)",
        cursor: "pointer",
        minWidth: 80,
      }}
    >
      <span style={{ fontSize: 17, fontWeight: 500, color: countColor, lineHeight: 1 }}>
        {count === null ? "—" : String(count)}
      </span>
      <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1 }}>{label}</span>
    </button>
  );
}

// ---- shared sub-components (unchanged) ----------------------------------------

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
    if (dto.warning) text += ` ⚠︎ ${dto.warning}`;
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
