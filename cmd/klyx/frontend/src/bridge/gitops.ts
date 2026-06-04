import { useFleet, FluxResourceDTO, ResourceDetailDTO } from "../store/fleet";
import { Events } from "@wailsio/runtime";
import { GitOpsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

const GITOPS_UPDATED = "gitops:updated";

export async function openGitOps(cluster: string): Promise<() => void> {
  useFleet.getState().setGitOpsLoading(cluster);
  await GitOpsService.Open(cluster);
  const off = Events.On(GITOPS_UPDATED, (ev: { data: { cluster: string; resources: FluxResourceDTO[] } }) => {
    const d = ev.data;
    if (d && d.cluster === cluster) {
      useFleet.getState().setGitOps(cluster, d.resources ?? []);
    }
  });
  return typeof off === "function" ? off : () => {};
}

export async function closeGitOps(cluster: string): Promise<void> {
  try {
    await GitOpsService.Close(cluster);
  } finally {
    useFleet.getState().clearGitOps();
  }
}

export async function getResourceDetail(cluster: string, kind: string, namespace: string, name: string): Promise<void> {
  const d = (await GitOpsService.GetResourceDetail(cluster, kind, namespace, name)) as ResourceDetailDTO;
  if (d && d.name) {
    useFleet.getState().setDetail(d);
  }
}
