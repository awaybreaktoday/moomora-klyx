import { useFleet, WorkloadsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listWorkloads(cluster: string, namespace: string): Promise<void> {
  useFleet.getState().setWorkloadsLoading(cluster, namespace);
  const r = (await WorkloadsService.ListWorkloads(cluster, namespace)) as WorkloadsResultDTO;
  // Drop a stale response if the user navigated away from this cluster.
  if (useFleet.getState().workloads.cluster !== cluster) return;
  useFleet.getState().setWorkloads(cluster, namespace, r ?? { fluxPresent: false, namespaces: [], workloads: [] });
}
