import { useFleet, OverviewSummary } from "../store/fleet";
import {
  WorkloadsService,
  PodsService,
  EventsService,
  NodesService,
  HelmService,
  GitOpsService,
} from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

// ---- pure summary math (exported for unit tests) --------------------------------

type RankedRow = { rank: string };
type EventRow = { type: string };
type NodeRow = { ready: boolean; problems: string[]; unschedulable: boolean };
type HelmRow = { status: string };
type FluxSummaryInput = { present: boolean; notReady: number; suspended: number } | null;

export type SummariseInput = {
  workloads: RankedRow[];
  pods: RankedRow[];
  events: EventRow[];
  nodes: NodeRow[];
  helmAvailable: boolean;
  releases: HelmRow[];
  flux: FluxSummaryInput;
};

export type SummariseOutput = {
  unhealthyWorkloads: number;
  podsNotReady: number;
  warningEvents: number;
  nodeProblems: number;
  helmAvailable: boolean;
  failedReleases: number | null; // null when helm unavailable
  namespaces: number;
  flux: { present: boolean; notReady: number; suspended: number } | null;
};

/**
 * summarise derives counts from the raw binding results.
 * Pure function — no side-effects; directly unit-testable.
 */
export function summarise(
  input: SummariseInput,
  distinctNamespaces: Set<string>,
): SummariseOutput {
  const unhealthyWorkloads = input.workloads.filter(
    (w) => w.rank === "unhealthy" || w.rank === "degraded",
  ).length;

  const podsNotReady = input.pods.filter(
    (p) => p.rank === "unhealthy" || p.rank === "degraded",
  ).length;

  const warningEvents = input.events.filter((e) => e.type === "Warning").length;

  const nodeProblems = input.nodes.filter(
    (n) => !n.ready || n.problems.length > 0 || n.unschedulable,
  ).length;

  const failedReleases = input.helmAvailable
    ? input.releases.filter((r) => r.status === "failed").length
    : null;

  const flux = input.flux && input.flux.present
    ? { present: true, notReady: input.flux.notReady, suspended: input.flux.suspended }
    : null;

  return {
    unhealthyWorkloads,
    podsNotReady,
    warningEvents,
    nodeProblems,
    helmAvailable: input.helmAvailable,
    failedReleases,
    namespaces: distinctNamespaces.size,
    flux,
  };
}

// ---- fetch orchestration -------------------------------------------------------

/**
 * fetchOverviewSummary fetches all five data sources in parallel, derives counts
 * via summarise(), and writes the result into overviewSummary in the fleet store.
 * Stale-guarded: if the cluster changes before all promises settle, the result is
 * silently dropped.
 */
export async function fetchOverviewSummary(cluster: string): Promise<void> {
  useFleet.getState().setOverviewSummaryLoading(cluster);

  const [workloadsResult, podsResult, eventsResult, nodesResult, helmResult, fluxResult] =
    await Promise.allSettled([
      WorkloadsService.ListWorkloads(cluster, ""),
      PodsService.ListPods(cluster, ""),
      EventsService.ListEvents(cluster, ""),
      NodesService.ListNodes(cluster),
      HelmService.ListHelmReleases(cluster),
      GitOpsService.GetGitOpsSummary(cluster),
    ]);

  // Stale guard — cluster may have changed while requests were in flight.
  if (useFleet.getState().overviewSummary.cluster !== cluster) return;

  // Extract per-tile values, null on failure.
  let unhealthyWorkloads: number | null = null;
  let podsNotReady: number | null = null;
  let warningEvents: number | null = null;
  let nodeProblems: number | null = null;
  let helmAvailable = false;
  let failedReleases: number | null = null;
  let namespaces: number | null = null;
  let flux: { present: boolean; notReady: number; suspended: number } | null = null;
  const nsSet = new Set<string>();

  // Pods — also source for namespace derivation.
  if (podsResult.status === "fulfilled" && podsResult.value) {
    const pods = (podsResult.value as { pods: RankedRow[] }).pods ?? [];
    podsNotReady = pods.filter(
      (p) => p.rank === "unhealthy" || p.rank === "degraded",
    ).length;
    // Derive distinct namespaces from the pods list (all-namespaces load).
    const rawPods = (podsResult.value as { pods: Array<{ rank: string; namespace?: string }> }).pods ?? [];
    for (const p of rawPods) {
      if (p.namespace) nsSet.add(p.namespace);
    }
    namespaces = nsSet.size > 0 ? nsSet.size : null;
  }

  if (workloadsResult.status === "fulfilled" && workloadsResult.value) {
    const workloads = (workloadsResult.value as { workloads: RankedRow[] }).workloads ?? [];
    unhealthyWorkloads = workloads.filter(
      (w) => w.rank === "unhealthy" || w.rank === "degraded",
    ).length;
  }

  if (eventsResult.status === "fulfilled" && eventsResult.value) {
    const events = (eventsResult.value as { events: EventRow[] }).events ?? [];
    warningEvents = events.filter((e) => e.type === "Warning").length;
  }

  if (nodesResult.status === "fulfilled" && nodesResult.value) {
    const nodes = (nodesResult.value as { nodes: NodeRow[] }).nodes ?? [];
    nodeProblems = nodes.filter(
      (n) => !n.ready || n.problems.length > 0 || n.unschedulable,
    ).length;
  }

  if (helmResult.status === "fulfilled" && helmResult.value) {
    const hr = helmResult.value as { available: boolean; releases: HelmRow[] };
    helmAvailable = hr.available ?? false;
    if (helmAvailable) {
      failedReleases = (hr.releases ?? []).filter((r) => r.status === "failed").length;
    }
  }

  if (fluxResult.status === "fulfilled" && fluxResult.value) {
    const fr = fluxResult.value as { fluxPresent: boolean; notReady: number; suspended: number };
    if (fr.fluxPresent) {
      flux = { present: true, notReady: fr.notReady ?? 0, suspended: fr.suspended ?? 0 };
    }
    // fluxPresent=false → flux stays null → tile is hidden
  }
  // fluxResult rejected → flux stays null → tile hides (same as "absent")

  const summary: OverviewSummary = {
    cluster,
    loading: false,
    unhealthyWorkloads,
    podsNotReady,
    warningEvents,
    nodeProblems,
    helmAvailable,
    failedReleases,
    namespaces,
    flux,
  };

  useFleet.getState().setOverviewSummary(summary);
}
