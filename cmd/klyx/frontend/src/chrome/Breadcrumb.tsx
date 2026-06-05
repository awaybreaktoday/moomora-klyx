import { useFleet, SECTION_LABELS } from "../store/fleet";

const crumbBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  color: "var(--color-text-info)", font: "inherit",
};

export function Breadcrumb() {
  const route = useFleet((s) => s.route);
  const openFleet = useFleet((s) => s.openFleet);
  const setSection = useFleet((s) => s.setSection);
  const closeResource = useFleet((s) => s.closeResource);

  if (route.name === "fleet") {
    return <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Fleet</span>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-text-tertiary)" }}>
      <button onClick={openFleet} style={crumbBtn}>Fleet</button>
      <span>/</span>
      <button onClick={() => setSection("overview")} style={{ ...crumbBtn, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
        {route.cluster}
      </button>
      {route.section !== "overview" && (
        <>
          <span>/</span>
          {route.resource ? (
            <button onClick={closeResource} style={crumbBtn}>{SECTION_LABELS[route.section]}</button>
          ) : (
            <span style={{ color: "var(--color-text-primary)" }}>{SECTION_LABELS[route.section]}</span>
          )}
          {route.resource && (
            <>
              <span>/</span>
              <span style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>{route.resource.kind}</span>
            </>
          )}
        </>
      )}
    </div>
  );
}
