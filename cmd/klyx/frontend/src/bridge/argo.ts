import { useFleet, ArgoResultDTO } from "../store/fleet";
import { ArgoService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type ActionResultDTO = { ok: boolean; error: string };

// listArgoApps fetches every Application on the cluster (broken-first sort is
// backend-side). Unavailable (no Argo, list failure) carries a message.
export async function listArgoApps(cluster: string): Promise<void> {
  useFleet.getState().setArgoLoading(cluster);
  try {
    const r = (await ArgoService.ListApplications(cluster)) as ArgoResultDTO;
    if (useFleet.getState().argo.cluster !== cluster) return;
    useFleet.getState().setArgo(cluster, r ?? { available: false, message: "no response", apps: [] });
  } catch (e) {
    if (useFleet.getState().argo.cluster === cluster) {
      useFleet.getState().setArgo(cluster, { available: false, message: String(e), apps: [] });
    }
  }
}

// refreshArgoApp triggers a re-compare against the source (Argo's reconcile).
export async function refreshArgoApp(cluster: string, namespace: string, name: string): Promise<void> {
  const r = (await ArgoService.RefreshApp(cluster, namespace, name)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok
      ? { kind: "success", message: `refresh requested for ${name}` }
      : { kind: "error", message: r.error || "Refresh failed" },
  );
  if (r.ok) void listArgoApps(cluster);
}

// syncArgoApp starts a sync at the app's target revision. Never prunes.
export async function syncArgoApp(cluster: string, namespace: string, name: string, revision: string): Promise<void> {
  const r = (await ArgoService.SyncApp(cluster, namespace, name, revision)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok
      ? { kind: "success", message: `sync started for ${name}` }
      : { kind: "error", message: r.error || "Sync failed" },
  );
  if (r.ok) void listArgoApps(cluster);
}
