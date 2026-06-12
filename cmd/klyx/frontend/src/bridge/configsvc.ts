import { useFleet } from "../store/fleet";
import { ConfigService, ExecService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type ActionResultDTO = { ok: boolean; error: string };

export type FleetClusterConfigDTO = {
  name: string;
  context: string;
  env: string;
  group: string;
  protected: boolean;
  hasMetrics: boolean;
};
export type KubeContextDTO = { name: string; inFleet: boolean };
export type FleetConfigDTO = {
  path: string;
  kubeconfigPath: string;
  warnings: string[];
  scanError?: string;
  clusters: FleetClusterConfigDTO[];
  contexts: KubeContextDTO[];
};

// getFleetConfig fetches the fleet file state plus a FRESH kubeconfig scan —
// the backend re-reads ~/.kube/config on every call, so opening Settings picks
// up newly added contexts without restarting Klyx.
export async function getFleetConfig(): Promise<FleetConfigDTO | null> {
  try {
    return (await ConfigService.GetFleetConfig()) as FleetConfigDTO;
  } catch (e) {
    console.error("fleet config", e);
    return null;
  }
}

// addClusters appends contexts to fleet.yaml (validated before write). The
// running fleet gains the new conns immediately (no restart needed).
export async function addClusters(contexts: string[]): Promise<ActionResultDTO> {
  try {
    return (await ConfigService.AddClusters(contexts)) as ActionResultDTO;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// refreshNewContextCount updates the sidebar's Settings badge (kubeconfig
// contexts not in the fleet). Called once at startup; Settings refreshes it on
// every add. Errors leave the badge at 0 — it never invents a count.
export async function refreshNewContextCount(): Promise<void> {
  try {
    const n = (await ConfigService.NewContextCount()) as number;
    useFleet.getState().setNewContexts(n ?? 0);
  } catch {
    useFleet.getState().setNewContexts(0);
  }
}

// openTerminal opens a plain external terminal window (macOS Terminal.app).
export async function openTerminal(): Promise<void> {
  try {
    const r = (await ExecService.OpenTerminal()) as ActionResultDTO;
    if (!r?.ok) {
      useFleet.getState().setActionStatus({ kind: "error", message: r?.error || "could not open terminal" });
    }
  } catch (e) {
    useFleet.getState().setActionStatus({ kind: "error", message: String(e) });
  }
}
