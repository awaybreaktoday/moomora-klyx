import { useFleet, SECTION_LABELS } from "../store/fleet";

// Header is the per-view title row, below the full-width TopBar. The breadcrumb
// and theme toggle live in the TopBar; this shows the current view's title and
// (on the fleet root) the cluster/region count chip.
export function Header() {
  const route = useFleet((s) => s.route);
  const clusters = useFleet((s) => s.clusters);
  const regions = new Set(clusters.map((c) => c.region).filter(Boolean));
  const title = route.name === "fleet" ? "Fleet" : SECTION_LABELS[route.section];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ fontSize: 17, fontWeight: 500 }}>{title}</div>
      {route.name === "fleet" && clusters.length > 0 && (
        <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>
          {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
          {regions.size > 0 ? ` · ${regions.size} region${regions.size === 1 ? "" : "s"}` : ""}
        </span>
      )}
    </div>
  );
}
