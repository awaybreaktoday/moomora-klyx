import { useEffect, type ReactNode } from "react";
import { useFleet } from "../store/fleet";
import { ClusterCard, clusterDiagnosticScore } from "./ClusterCard";
import { MeshStrip } from "./MeshStrip";
import { getMeshGraph } from "../bridge/mesh";
import { fetchFleetBoard } from "../bridge/fleetboard";

export function FleetView() {
  const clusters = useFleet((s) => s.clusters);
  const mesh = useFleet((s) => s.mesh);
  const fleetBoard = useFleet((s) => s.fleetBoard);
  // Board enrichment fetches once per set of CONNECTED clusters (a cluster
  // coming online re-triggers); per-card fields degrade independently.
  const connectedKey = clusters
    .filter((c) => c.state !== "Failed" && c.state !== "Unconnected")
    .map((c) => c.name)
    .join(",");
  useEffect(() => {
    getMeshGraph().catch((e) => console.error("getMeshGraph", e));
  }, []);
  useEffect(() => {
    if (connectedKey === "") return;
    void fetchFleetBoard(connectedKey.split(","));
  }, [connectedKey]);

  const orderedClusters = [...clusters].sort((a, b) => {
    const score = clusterDiagnosticScore(b, fleetBoard[b.name]) - clusterDiagnosticScore(a, fleetBoard[a.name]);
    if (score !== 0) return score;
    return a.name.localeCompare(b.name);
  });
  const connected = clusters.filter((c) => c.state !== "Failed" && c.state !== "Unconnected" && c.state !== "Connecting").length;
  const allConnected = connected === clusters.length;

  return (
    <div style={{ padding: "14px 16px", display: "grid", gap: 12 }}>
      {clusters.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No clusters connected yet.</div>
      ) : (
        <>
          {mesh && <MeshStrip graph={mesh} />}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            border: "0.5px solid var(--color-border-tertiary)",
            background: "var(--color-background-secondary)",
            padding: "9px 12px",
          }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Fleet board</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <BoardChip strong>diagnostic order</BoardChip>
              <BoardChip>{clusters.length} cluster{clusters.length === 1 ? "" : "s"}</BoardChip>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: allConnected ? "var(--color-text-success)" : "var(--color-text-warning)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: allConnected ? "var(--color-text-success)" : "var(--color-text-warning)" }} />
                {allConnected ? "all informer factories connected" : `${connected}/${clusters.length} informer factories connected`}
              </span>
            </div>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: 8,
            alignItems: "stretch",
          }}>
            {orderedClusters.map((c) => <ClusterCard key={c.name} c={c} />)}
          </div>
        </>
      )}
    </div>
  );
}

function BoardChip({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <span style={{
      border: "0.5px solid var(--color-border-tertiary)",
      background: strong ? "var(--color-background-primary)" : "transparent",
      color: strong ? "var(--color-text-primary)" : "var(--color-text-secondary)",
      padding: "4px 8px",
      fontSize: 12,
      fontWeight: strong ? 600 : 400,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}
