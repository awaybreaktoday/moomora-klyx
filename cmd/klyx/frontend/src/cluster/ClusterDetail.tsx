import { useFleet } from "../store/fleet";
import { Overview } from "./Overview";
import { Placeholder } from "../chrome/Placeholder";

export function ClusterDetail() {
  const route = useFleet((s) => s.route);
  const cluster = useFleet((s) => {
    if (s.route.name !== "cluster") return undefined;
    const clusterName = s.route.cluster;
    return s.clusters.find((x) => x.name === clusterName);
  });

  if (route.name !== "cluster") return null;
  if (!cluster) {
    return (
      <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>
        This cluster is no longer in the fleet.
      </div>
    );
  }
  return route.section === "overview"
    ? <Overview c={cluster} />
    : <Placeholder section={route.section} c={cluster} />;
}
