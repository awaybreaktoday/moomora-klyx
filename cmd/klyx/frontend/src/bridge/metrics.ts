import { useFleet, MetricsDTO } from "../store/fleet";
import { MetricsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function getClusterMetrics(cluster: string, forceReprobe: boolean): Promise<void> {
  useFleet.getState().setMetricsLoading(cluster);
  const dto = (await MetricsService.GetClusterMetrics(cluster, forceReprobe)) as MetricsDTO;
  // Ignore a stale response if the user navigated to another cluster.
  if (useFleet.getState().metrics.cluster !== cluster) return;
  useFleet.getState().setMetrics(cluster, dto);
}
