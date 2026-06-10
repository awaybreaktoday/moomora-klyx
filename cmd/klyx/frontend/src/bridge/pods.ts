import { Events } from "@wailsio/runtime";
import { useFleet, PodsResultDTO, PodDetailDTO } from "../store/fleet";
import { PodsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type ActionResultDTO = { ok: boolean; error: string };

export async function listPods(cluster: string, namespace: string): Promise<void> {
  useFleet.getState().setPodsLoading(cluster, namespace);
  try {
    const r = (await PodsService.ListPods(cluster, namespace)) as PodsResultDTO;
    // Drop a stale response if the user changed cluster OR namespace while in flight.
    const cur = useFleet.getState().pods;
    if (cur.cluster !== cluster || cur.namespace !== namespace) return;
    useFleet.getState().setPods(cluster, namespace, r ?? { namespaces: [], pods: [] });
  } catch {
    // Clear the loading flag so the view doesn't get stuck on "Loading…".
    if (useFleet.getState().pods.cluster === cluster) {
      useFleet.setState((s) => ({ pods: { ...s.pods, loading: false } }));
    }
  }
}

// openLivePods subscribes to live pod updates for a cluster+namespace.
// The backend fires an immediate emit so the view receives data without calling
// listPods first. Returns a cleanup function to be called on unmount or ns change.
export function openLivePods(cluster: string, namespace: string): () => void {
  const dataEvent = "livePods:" + cluster + ":" + namespace;
  const statusEvent = "livePodsStatus:" + cluster + ":" + namespace;

  const offData = Events.On(dataEvent, (ev: { data: PodsResultDTO }) => {
    const cur = useFleet.getState().pods;
    if (cur.cluster !== cluster || cur.namespace !== namespace) return;
    useFleet.getState().setPods(cluster, namespace, ev.data ?? { namespaces: [], pods: [] });
  });

  const offStatus = Events.On(statusEvent, (ev: { data: { live: boolean } }) => {
    useFleet.getState().setPodsLive(cluster, namespace, ev.data?.live ?? false);
  });

  // Fire-and-forget: on error set live false so the indicator degrades honestly.
  PodsService.OpenLivePods(cluster, namespace).catch(() => {
    useFleet.getState().setPodsLive(cluster, namespace, false);
  });

  return () => {
    if (typeof offData === "function") offData();
    if (typeof offStatus === "function") offStatus();
    PodsService.CloseLivePods(cluster, namespace).catch(() => undefined);
  };
}

export async function deletePod(cluster: string, namespace: string, name: string): Promise<void> {
  const r = (await PodsService.DeletePod(cluster, namespace, name)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok
      ? { kind: "success", message: `pod ${namespace}/${name} deleted` }
      : { kind: "error", message: r.error || "Delete failed" },
  );
  if (r.ok) {
    const cur = useFleet.getState().pods;
    void listPods(cluster, cur.namespace);
  }
}

export async function openPodDetail(cluster: string, namespace: string, name: string): Promise<void> {
  const ref = { namespace, name };
  useFleet.getState().selectPod(ref);
  try {
    const d = (await PodsService.GetPodDetail(cluster, namespace, name)) as PodDetailDTO;
    const sel = useFleet.getState().pods.selected;
    if (!sel || sel.namespace !== namespace || sel.name !== name) return;
    useFleet.getState().setPodDetail(ref, d);
  } catch {
    // On failure, clear detailLoading so the panel doesn't spin forever.
    const sel = useFleet.getState().pods.selected;
    if (sel && sel.namespace === namespace && sel.name === name) {
      useFleet.setState((s) => ({ pods: { ...s.pods, detailLoading: false } }));
    }
  }
}
