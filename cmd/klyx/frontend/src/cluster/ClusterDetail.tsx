import { useFleet } from "../store/fleet";
import { Overview } from "./Overview";
import { GitOps } from "./GitOps";
import { CRDBrowser } from "./CRDBrowser";
import { InstanceList } from "./InstanceList";
import { InstanceDetail } from "./InstanceDetail";
import { NetworkView } from "./NetworkView";
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
  if (route.section === "overview") return <Overview c={cluster} />;
  if (route.section === "gitops") return <GitOps cluster={cluster.name} />;
  if (route.section === "resources") {
    if (route.resource && route.instance) return <InstanceDetail cluster={cluster.name} resource={route.resource} instance={route.instance} />;
    if (route.resource) return <InstanceList cluster={cluster.name} resource={route.resource} />;
    return <CRDBrowser cluster={cluster.name} />;
  }
  if (route.section === "network") return <NetworkView cluster={cluster.name} />;
  return <Placeholder section={route.section} c={cluster} />;
}
