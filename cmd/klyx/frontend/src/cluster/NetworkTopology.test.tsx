import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, TopologyDTO, GatewayRef } from "../store/fleet";
import { NetworkTopology } from "./NetworkTopology";

vi.mock("../bridge/gateway", () => ({ getGatewayTopology: vi.fn(async () => {}), listGateways: vi.fn(async () => {}) }));

const gateway: GatewayRef = { namespace: "infra", name: "eg" };
const topo: TopologyDTO = {
  gateway: { namespace: "infra", name: "eg", className: "envoy-gateway", accepted: true, programmed: true, listeners: [{ name: "https", protocol: "HTTPS", hostname: "", port: 443 }], policies: [] },
  routes: [
    { namespace: "apps", name: "share", hostnames: ["share.example.com"], matches: [{ pathType: "PathPrefix", pathValue: "/api/share", method: "GET" }], accepted: true, resolvedRefs: true, backends: [{ kind: "Service", name: "share-api", namespace: "apps", port: 8080, weight: 100 }], services: [{ namespace: "apps", name: "share-api", type: "ClusterIP", port: 8080, resolved: true, cnps: [] }], pods: { ready: 3, total: 3, unknown: false }, policies: [] },
  ],
  warnings: ["route apps/share has 2 backends; the lane shows the primary"],
};

function seed(t: TopologyDTO | null, loading = false) {
  useFleet.setState({ network: { served: true, gateways: [], listLoading: false, selected: gateway, topology: t, topologyLoading: loading, selectedRoute: null } });
}

beforeEach(() => { vi.clearAllMocks(); seed(topo); });

describe("NetworkTopology", () => {
  it("renders the gateway + route + service + pods lane", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText("eg")).toBeTruthy();
    expect(getByText("share")).toBeTruthy();
    expect(getByText("share-api")).toBeTruthy();
    expect(getByText(/3 \/ 3/)).toBeTruthy();
  });

  it("surfaces warnings", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/shows the primary/i)).toBeTruthy();
  });

  it("clicking a route selects it (detail panel)", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share"));
    expect(useFleet.getState().network.selectedRoute).toBe("apps/share");
    expect(getByText(/PathPrefix/)).toBeTruthy();
  });

  it("shows the error block when topology.error is set", () => {
    seed({ gateway: topo.gateway, routes: [], error: "get gateway failed" });
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/get gateway failed/i)).toBeTruthy();
  });

  it("shows no-routes empty state", () => {
    seed({ gateway: topo.gateway, routes: [], warnings: [] });
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/No HTTPRoutes attached/i)).toBeTruthy();
  });
});
