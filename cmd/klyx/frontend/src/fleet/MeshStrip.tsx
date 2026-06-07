import type { MeshGraphDTO } from "../store/fleet";

const node: React.CSSProperties = {
  background: "var(--color-background-primary)", border: "1px solid var(--color-border-info)",
  borderRadius: 7, padding: "5px 10px", fontFamily: "var(--font-mono)", fontSize: 11,
};

export function MeshStrip({ graph }: { graph: MeshGraphDTO }) {
  // Render only when at least one cluster has ClusterMesh installed.
  const meshy = graph.nodes.some((n) => n.state !== "unavailable");
  if (!meshy) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--color-text-tertiary)" }}>clustermesh</span>
        <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>configured peering (not live connectivity)</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "12px 14px" }}>
        {graph.nodes.map((n) => {
          const standalone = n.state === "enabled";
          const off = !n.present;
          return (
            <span
              key={n.cluster || n.name}
              style={{
                ...node,
                borderColor: off || standalone ? "var(--color-border-tertiary)" : "var(--color-border-info)",
                color: off ? "var(--color-text-tertiary)" : standalone ? "var(--color-text-secondary)" : "var(--color-text-primary)",
                opacity: off ? 0.6 : 1,
              }}
              title={off ? "off-fleet peer (not connected to Klyx)" : standalone ? "mesh enabled, no peers" : "meshed"}
            >
              <span>{n.name}</span>{standalone ? " ⬡" : ""}{off ? " (off-fleet)" : ""}
            </span>
          );
        })}
      </div>
      {graph.edges.some((e) => !e.mutual) && (
        <div style={{ fontSize: 9, color: "var(--color-text-warning)", marginTop: 4 }}>⚠ dashed = asymmetric / off-fleet (one-way configured)</div>
      )}
    </div>
  );
}
