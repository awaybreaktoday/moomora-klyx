import { Events } from "@wailsio/runtime";
import { useFleet, WorkloadsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type ActionResultDTO = { ok: boolean; error: string };

export async function scaleWorkload(cluster: string, kind: string, namespace: string, name: string, replicas: number): Promise<void> {
  const r = (await WorkloadsService.ScaleWorkload(cluster, kind, namespace, name, replicas)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok
      ? { kind: "success", message: `scaled ${kind.toLowerCase()} ${namespace}/${name} to ${replicas}` }
      : { kind: "error", message: r.error || "Scale failed" },
  );
  if (r.ok) {
    const cur = useFleet.getState().workloads;
    void listWorkloads(cluster, cur.namespace);
  }
}

export async function rolloutRestart(cluster: string, kind: string, namespace: string, name: string): Promise<void> {
  const r = (await WorkloadsService.RolloutRestart(cluster, kind, namespace, name)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok
      ? { kind: "success", message: `restart triggered for ${kind.toLowerCase()} ${namespace}/${name}` }
      : { kind: "error", message: r.error || "Restart failed" },
  );
  if (r.ok) {
    const cur = useFleet.getState().workloads;
    void listWorkloads(cluster, cur.namespace);
  }
}

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

// openLiveWorkloads subscribes to live workload updates for a cluster+namespace.
// The backend fires an immediate emit so the view receives data without calling
// listWorkloads first. Returns a cleanup function to be called on unmount.
export function openLiveWorkloads(cluster: string, namespace: string): () => void {
  const dataEvent = "liveWorkloads:" + cluster + ":" + namespace;
  const statusEvent = "liveWorkloadsStatus:" + cluster + ":" + namespace;

  const offData = Events.On(dataEvent, (ev: { data: WorkloadsResultDTO }) => {
    const cur = useFleet.getState().workloads;
    if (cur.cluster !== cluster || cur.namespace !== namespace) return;
    useFleet.getState().setWorkloads(cluster, namespace, ev.data ?? { fluxPresent: false, namespaces: [], workloads: [] });
  });

  const offStatus = Events.On(statusEvent, (ev: { data: { live: boolean } }) => {
    useFleet.getState().setWorkloadsLive(cluster, namespace, ev.data?.live ?? false);
  });

  // Fire-and-forget: on error set live false so the indicator degrades honestly.
  WorkloadsService.OpenLiveWorkloads(cluster, namespace).catch(() => {
    useFleet.getState().setWorkloadsLive(cluster, namespace, false);
  });

  return () => {
    if (typeof offData === "function") offData();
    if (typeof offStatus === "function") offStatus();
    WorkloadsService.CloseLiveWorkloads(cluster, namespace).catch(() => undefined);
  };
}
