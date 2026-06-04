import { useFleet } from "../store/fleet";
import { ClusterCard } from "./ClusterCard";

export function FleetView() {
  const clusters = useFleet((s) => s.clusters);
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 17, fontWeight: 500, marginBottom: 12 }}>Fleet</div>
      {clusters.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No clusters connected yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {clusters.map((c) => <ClusterCard key={c.name} c={c} />)}
        </div>
      )}
    </div>
  );
}
