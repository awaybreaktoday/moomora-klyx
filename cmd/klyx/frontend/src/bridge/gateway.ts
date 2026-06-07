import { useFleet, GatewayListDTO, TopologyDTO, GatewayRef, RouteMetricsResultDTO } from "../store/fleet";
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

export async function getRouteMetrics(cluster: string, gwNamespace: string, gwName: string, routeKeys: string[]): Promise<void> {
  const r = (await GatewayService.GetRouteMetrics(cluster, routeKeys)) as RouteMetricsResultDTO;
  // Drop a stale result if the user switched gateways while this was in flight.
  const cur = useFleet.getState().network.selected;
  if (!cur || cur.namespace !== gwNamespace || cur.name !== gwName) return;
  useFleet.getState().setRouteMetrics(r ?? { status: { available: false, message: "", updatedAt: "" }, routes: {} });
}
