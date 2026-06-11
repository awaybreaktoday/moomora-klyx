import { useFleet } from "../store/fleet";
import type { FleetBoardEntry } from "../store/fleet";
import {
  MetricsService,
  GitOpsService,
  ArgoService,
  WorkloadsService,
} from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type MetricsDTO = { available: boolean; cpuFraction: number | null; memFraction: number | null };
type GitOpsSummaryDTO = { fluxPresent: boolean; total: number; notReady: number; suspended: number };
type ArgoResultDTO = { available: boolean; apps: { broken: boolean }[] };
type WorkloadsResultDTO = { workloads: { rank: string }[] };

// fetchFleetBoard enriches each connected cluster's card with utilization,
// GitOps state (Flux + Argo, each tool's own counts), and a broken-workloads
// count. On-demand: once per fleet-view visit, all clusters in parallel, each
// field independently null/absent on failure - the card states "—", never a
// fabricated zero. Every backend read is cached or informer-backed.
export async function fetchFleetBoard(clusters: string[]): Promise<void> {
  await Promise.all(clusters.map(async (cluster) => {
    const [metrics, gitops, argo, workloads] = await Promise.allSettled([
      MetricsService.GetClusterMetrics(cluster, false),
      GitOpsService.GetGitOpsSummary(cluster),
      ArgoService.ListApplications(cluster),
      WorkloadsService.ListWorkloads(cluster, ""),
    ]);

    const entry: FleetBoardEntry = {
      cpuFraction: null, memFraction: null,
      broken: null, flux: null, argo: null,
    };

    if (metrics.status === "fulfilled" && metrics.value) {
      const m = metrics.value as MetricsDTO;
      if (m.available) {
        entry.cpuFraction = m.cpuFraction;
        entry.memFraction = m.memFraction;
      }
    }
    if (gitops.status === "fulfilled" && gitops.value) {
      const g = gitops.value as GitOpsSummaryDTO;
      if (g.fluxPresent) entry.flux = { total: g.total, notReady: g.notReady };
    }
    if (argo.status === "fulfilled" && argo.value) {
      const a = argo.value as ArgoResultDTO;
      if (a.available) entry.argo = { total: a.apps.length, broken: a.apps.filter((x) => x.broken).length };
    }
    if (workloads.status === "fulfilled" && workloads.value) {
      const w = (workloads.value as WorkloadsResultDTO).workloads ?? [];
      entry.broken = w.filter((x) => x.rank === "unhealthy" || x.rank === "degraded").length;
    }

    useFleet.getState().setFleetBoardEntry(cluster, entry);
  }));
}
