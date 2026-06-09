import { useFleet, PodsResultDTO, PodDetailDTO } from "../store/fleet";
import { PodsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

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
