import { useFleet } from "../store/fleet";
import type { TapeCounts } from "../store/fleet";
import {
  WorkloadsService,
  PodsService,
  EventsService,
  NodesService,
  HelmService,
  GitOpsService,
  ArgoService,
} from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type Ranked = { rank: string };

// fetchTape populates the persistent triage tape for a cluster: one fetch per
// cluster ENTRY (not per section switch - the tape survives navigation). Count
// derivations mirror fetchOverviewSummary exactly so the tape and the Overview
// tiles never disagree. Each count degrades independently to null (the tape
// skips what it could not read - it never claims quiet from missing data).
export async function fetchTape(cluster: string): Promise<void> {
  useFleet.getState().setTapeLoading(cluster);

  const [workloads, pods, events, nodes, helm, flux, argo] = await Promise.allSettled([
    WorkloadsService.ListWorkloads(cluster, ""),
    PodsService.ListPods(cluster, ""),
    EventsService.ListEvents(cluster, ""),
    NodesService.ListNodes(cluster),
    HelmService.ListHelmReleases(cluster),
    GitOpsService.GetGitOpsSummary(cluster),
    ArgoService.ListApplications(cluster),
  ]);

  if (useFleet.getState().tape.cluster !== cluster) return; // stale guard

  // Default everything to unreadable; each lens then proves itself either a
  // real count or definitively absent.
  const counts: TapeCounts = {
    workloads: "unreadable", pods: "unreadable", events: "unreadable", nodes: "unreadable",
    helm: "unreadable", flux: "unreadable", argo: "unreadable",
  };

  if (workloads.status === "fulfilled" && workloads.value) {
    const w = ((workloads.value as { workloads: Ranked[] }).workloads ?? []);
    counts.workloads = w.filter((x) => x.rank === "unhealthy" || x.rank === "degraded").length;
  }
  if (pods.status === "fulfilled" && pods.value) {
    const p = ((pods.value as { pods: Ranked[] }).pods ?? []);
    counts.pods = p.filter((x) => x.rank === "unhealthy" || x.rank === "degraded").length;
  }
  if (events.status === "fulfilled" && events.value) {
    const e = ((events.value as { events: { type: string }[] }).events ?? []);
    counts.events = e.filter((x) => x.type === "Warning").length;
  }
  if (nodes.status === "fulfilled" && nodes.value) {
    const n = ((nodes.value as { nodes: { ready: boolean; problems: string[]; unschedulable: boolean }[] }).nodes ?? []);
    counts.nodes = n.filter((x) => !x.ready || x.problems.length > 0 || x.unschedulable).length;
  }
  if (helm.status === "fulfilled" && helm.value) {
    const h = helm.value as { available: boolean; releases: { status: string }[] };
    // available=false is a definitive "helm not detected", not a failure.
    counts.helm = h.available ? (h.releases ?? []).filter((r) => r.status === "failed").length : "absent";
  }
  if (flux.status === "fulfilled" && flux.value) {
    const f = flux.value as { fluxPresent: boolean; notReady: number };
    counts.flux = f.fluxPresent ? (f.notReady ?? 0) : "absent";
  }
  if (argo.status === "fulfilled" && argo.value) {
    const a = argo.value as { available: boolean; apps: { broken: boolean }[]; message?: string };
    if (a.available) counts.argo = (a.apps ?? []).filter((x) => x.broken).length;
    // "not detected" is absence; any other unavailable message is a real failure.
    else counts.argo = (a.message ?? "").includes("not detected") ? "absent" : "unreadable";
  }

  useFleet.getState().setTape(cluster, counts);
}
