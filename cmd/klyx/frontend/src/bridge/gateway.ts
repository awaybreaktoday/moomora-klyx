import { useFleet, GatewayListDTO, TopologyDTO, GatewayRef } from "../store/fleet";
import { GatewayService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listGateways(cluster: string): Promise<void> {
  useFleet.getState().setGatewaysLoading();
  const l = (await GatewayService.ListGateways(cluster)) as GatewayListDTO;
  useFleet.getState().setGateways(l ?? { gatewayAPIServed: false, gateways: [] });
}

export async function getGatewayTopology(cluster: string, ref: GatewayRef): Promise<void> {
  useFleet.getState().setTopologyLoading(ref);
  const t = (await GatewayService.GetGatewayTopology(cluster, ref.namespace, ref.name)) as TopologyDTO;
  const cur = useFleet.getState().network.selected;
  if (!cur || cur.namespace !== ref.namespace || cur.name !== ref.name) return;
  useFleet.getState().setTopology(t);
}
