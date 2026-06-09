import { useFleet, WorkloadMetricsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

// getWorkloadMetrics fetches live usage and patch-merges it into the current rows.
// Stale-guarded on cluster+namespace by setWorkloadUsage. Failures are swallowed
// (the store keeps last-good usage and marks stale); loading is owned by listWorkloads.
export async function getWorkloadMetrics(cluster: string, namespace: string): Promise<void> {
  try {
    const r = (await WorkloadsService.GetWorkloadMetrics(cluster, namespace)) as WorkloadMetricsResultDTO;
    useFleet.getState().setWorkloadUsage(cluster, namespace, r ?? { status: { available: false, message: "", updatedAt: "" }, usage: {} });
  } catch {
    useFleet.getState().setWorkloadUsage(cluster, namespace, { status: { available: false, message: "metrics request failed", updatedAt: "" }, usage: {} });
  }
}
