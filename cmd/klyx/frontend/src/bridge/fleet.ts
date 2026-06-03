import { useFleet, ClusterDTO } from "../store/fleet";
import { Events } from "@wailsio/runtime";
import { FleetService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

const FLEET_UPDATED = "fleet:updated";

export async function initFleetBridge(): Promise<() => void> {
  // Seed the store with the current fleet from Go.
  // GetFleet returns ClusterDTO class instances from the generated binding;
  // they have the same JSON shape as the store's plain ClusterDTO type.
  const seed = await FleetService.GetFleet();
  useFleet.getState().setClusters((seed ?? []) as unknown as ClusterDTO[]);

  // Subscribe to live push updates.
  const off = Events.On(FLEET_UPDATED, (ev) => {
    const data = (ev.data ?? []) as ClusterDTO[];
    useFleet.getState().setClusters(data);
  });

  return typeof off === "function" ? off : () => {};
}
