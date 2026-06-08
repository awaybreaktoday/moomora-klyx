import { useFleet, WorkloadsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listWorkloads(cluster: string, namespace: string): Promise<void> {
  useFleet.getState().setWorkloadsLoading(cluster, namespace);
  try {
    const r = (await WorkloadsService.ListWorkloads(cluster, namespace)) as WorkloadsResultDTO;
    // Drop a stale response if the user changed cluster OR namespace while in flight.
    const cur = useFleet.getState().workloads;
    if (cur.cluster !== cluster || cur.namespace !== namespace) return;
    useFleet.getState().setWorkloads(cluster, namespace, r ?? { fluxPresent: false, namespaces: [], workloads: [] });
  } catch {
    // On failure, clear the loading flag (keep any existing items) so the view
    // doesn't get stuck on "Loading…". Only if still on this cluster.
    if (useFleet.getState().workloads.cluster === cluster) {
      useFleet.setState((s) => ({ workloads: { ...s.workloads, loading: false } }));
    }
  }
}
