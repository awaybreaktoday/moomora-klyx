import { useFleet, NodesResultDTO, NodeDetailDTO } from "../store/fleet";
import { NodesService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listNodes(cluster: string): Promise<void> {
  useFleet.getState().setNodesLoading(cluster);
  try {
    const r = (await NodesService.ListNodes(cluster)) as NodesResultDTO;
    // Drop a stale response if the user changed cluster while in flight.
    const cur = useFleet.getState().nodes;
    if (cur.cluster !== cluster) return;
    useFleet.getState().setNodes(cluster, r ?? { nodes: [] });
  } catch {
    // Clear the loading flag so the view doesn't get stuck on "Loading…".
    if (useFleet.getState().nodes.cluster === cluster) {
      useFleet.setState((s) => ({ nodes: { ...s.nodes, loading: false } }));
    }
  }
}

export async function openNodeDetail(cluster: string, name: string): Promise<void> {
  const ref = { name };
  useFleet.getState().selectNode(ref);
  try {
    const d = (await NodesService.GetNodeDetail(cluster, name)) as NodeDetailDTO;
    const sel = useFleet.getState().nodes.selected;
    if (!sel || sel.name !== name) return;
    useFleet.getState().setNodeDetail(ref, d);
  } catch {
    // On failure, clear detailLoading so the panel doesn't spin forever.
    const sel = useFleet.getState().nodes.selected;
    if (sel && sel.name === name) {
      useFleet.setState((s) => ({ nodes: { ...s.nodes, detailLoading: false } }));
    }
  }
}
