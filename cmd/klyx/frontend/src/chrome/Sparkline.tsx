// Sparkline — a tiny pure-SVG line for 30m metric series. No chart library,
// no animation, no axes. Honesty rules: x is mapped by TIMESTAMP (not index),
// and the line BREAKS where Prometheus skipped steps — a gap renders as a gap,
// never an interpolated bridge. Empty input renders a muted "no data" label.

export type SparkPoint = { t: number; v: number };

export function Sparkline({
  points,
  width = 120,
  height = 24,
  stepSeconds = 60,
  stroke = "var(--color-text-info)",
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
  // Expected sample spacing; consecutive points further apart than 1.5 steps
  // start a new segment (the visible gap).
  stepSeconds?: number;
  stroke?: string;
}) {
  if (points.length === 0) {
    return (
      <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>no data</span>
    );
  }

  const pad = 2;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);
  let maxV = 0;
  for (const p of points) if (p.v > maxV) maxV = p.v;
  // Flat-zero series still draws a line along the baseline.
  const spanV = maxV === 0 ? 1 : maxV;

  const x = (t: number) => pad + ((t - minT) / spanT) * (width - 2 * pad);
  const y = (v: number) => height - pad - (v / spanV) * (height - 2 * pad);

  // Split into segments at gaps.
  const segments: SparkPoint[][] = [];
  let cur: SparkPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > 1.5 * stepSeconds) {
      segments.push(cur);
      cur = [];
    }
    cur.push(points[i]);
  }
  segments.push(cur);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="metric sparkline"
      style={{ display: "block", flexShrink: 0 }}
    >
      {segments.map((seg, i) =>
        seg.length === 1 ? (
          // A lone point between gaps still deserves a mark.
          <circle key={i} cx={x(seg[0].t)} cy={y(seg[0].v)} r={1.2} fill={stroke} />
        ) : (
          <polyline
            key={i}
            points={seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={stroke}
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ),
      )}
    </svg>
  );
}
