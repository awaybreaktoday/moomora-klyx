import { useFleet, SECTION_LABELS } from "../store/fleet";
import { Breadcrumb } from "./Breadcrumb";

// Header is the per-view content header, below the full-width TopBar. The
// breadcrumb sits directly above the title so both share the content column's
// left edge (aligned with the body). The theme toggle lives in the TopBar.
export function Header() {
  const route = useFleet((s) => s.route);
  const clusters = useFleet((s) => s.clusters);
  const regions = new Set(clusters.map((c) => c.region).filter(Boolean));
  const title = route.name === "fleet" ? "Fleet" : route.name === "forwards" ? "Port-forwards" : route.name === "settings" ? "Settings" : SECTION_LABELS[route.section];

  return (
    <div style={{ padding: "10px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
      <Breadcrumb />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <div style={{ fontSize: 17, fontWeight: 500 }}>{title}</div>
        {route.name === "fleet" && clusters.length > 0 && (
          <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>
            {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
            {regions.size > 0 ? ` · ${regions.size} region${regions.size === 1 ? "" : "s"}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
