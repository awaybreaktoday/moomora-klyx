import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import { ClusterCard } from "./ClusterCard";
import { MeshStrip } from "./MeshStrip";
import { getMeshGraph } from "../bridge/mesh";

export function FleetView() {
  const clusters = useFleet((s) => s.clusters);
  const mesh = useFleet((s) => s.mesh);
  useEffect(() => {
    getMeshGraph().catch((e) => console.error("getMeshGraph", e));
  }, []);
  return (
    <div style={{ padding: "14px 16px" }}>
      {clusters.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No clusters connected yet.</div>
      ) : (
        <>
          {mesh && <MeshStrip graph={mesh} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {clusters.map((c) => <ClusterCard key={c.name} c={c} />)}
          </div>
        </>
      )}
    </div>
  );
}
