import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, TopologyDTO, GatewayRef } from "../store/fleet";
import { NetworkTopology } from "./NetworkTopology";

vi.mock("../bridge/gateway", () => ({ getGatewayTopology: vi.fn(async () => {}), listGateways: vi.fn(async () => {}) }));

const gateway: GatewayRef = { namespace: "infra", name: "eg" };
const topo: TopologyDTO = {
  gateway: { namespace: "infra", name: "eg", className: "envoy-gateway", accepted: true, programmed: true, listeners: [{ name: "https", protocol: "HTTPS", hostname: "", port: 443 }], policies: [] },
  routes: [
    { namespace: "apps", name: "share", hostnames: ["share.example.com"], matches: [{ pathType: "PathPrefix", pathValue: "/api/share", method: "GET" }], accepted: true, resolvedRefs: true, backends: [{ kind: "Service", name: "share-api", namespace: "apps", port: 8080, weight: 100 }], services: [{ namespace: "apps", name: "share-api", type: "ClusterIP", port: 8080, resolved: true, global: false, meshClusters: [], meshUnconfirmed: false, policies: [], cnps: [] }], pods: { ready: 3, total: 3, unknown: false }, policies: [] },
  ],
  warnings: ["route apps/share has 2 backends; the lane shows the primary"],
};

function route(namespace: string, name: string, path: string): TopologyDTO["routes"][number] {
  const svc = `${name}-svc`;
  return { namespace, name, hostnames: [], matches: [{ pathType: "PathPrefix", pathValue: path, method: "" }], accepted: true, resolvedRefs: true, backends: [{ kind: "Service", name: svc, namespace, port: 80, weight: 0 }], services: [{ namespace, name: svc, type: "ClusterIP", port: 80, resolved: true, global: false, meshClusters: [], meshUnconfirmed: false, policies: [], cnps: [] }], pods: { ready: 1, total: 1, unknown: false }, policies: [] };
}

const multiTopo: TopologyDTO = {
  gateway: topo.gateway,
  routes: [route("apps", "share", "/share"), route("monitoring", "grafana", "/grafana")],
  warnings: [],
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

  it("shows no namespace filter when routes span a single namespace", () => {
    seed(topo); // one route in "apps"
    const { queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(queryByText("All")).toBeNull();
  });

  it("shows a namespace filter when routes span multiple namespaces", () => {
    seed(multiTopo);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText("All")).toBeTruthy();
    expect(getByText("apps")).toBeTruthy();
    expect(getByText("monitoring")).toBeTruthy();
    // both routes visible by default
    expect(getByText("share")).toBeTruthy();
    expect(getByText("grafana")).toBeTruthy();
  });

  it("filtering by namespace narrows the visible routes", () => {
    seed(multiTopo);
    const { getByText, queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("monitoring"));
    expect(getByText("grafana")).toBeTruthy();
    expect(queryByText("share")).toBeNull();
    // returning to All restores everything
    fireEvent.click(getByText("All"));
    expect(queryByText("share")).toBeTruthy();
  });

  it("falls back to a dropdown (not chips) above the namespace threshold", () => {
    const routes = Array.from({ length: 12 }, (_, i) => route(`ns-${i}`, `r-${i}`, `/r${i}`));
    seed({ gateway: topo.gateway, routes, warnings: [] });
    const { getByRole, queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    const select = getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(queryByText("All")).toBeNull(); // no chip wall
    // selecting a namespace narrows the lanes
    fireEvent.change(select, { target: { value: "ns-3" } });
    expect(queryByText("r-3")).toBeTruthy();
    expect(queryByText("r-0")).toBeNull();
  });

  it("uses chips (no dropdown) at or below the threshold", () => {
    seed(multiTopo); // 2 namespaces
    const { queryByRole, getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(queryByRole("combobox")).toBeNull();
    expect(getByText("All")).toBeTruthy();
  });

  it("hides the detail panel for a selected route filtered out of view", () => {
    seed(multiTopo);
    const { getByText, queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share")); // select apps/share -> detail panel shows
    expect(queryByText("HTTPRoute")).toBeTruthy(); // detail-only badge
    fireEvent.click(getByText("monitoring")); // filter away apps
    expect(queryByText("share")).toBeNull(); // lane gone
    expect(queryByText("HTTPRoute")).toBeNull(); // detail panel gone too
  });

  it("renders policy chips on the gateway header, route, and service", () => {
    const withPolicies: TopologyDTO = {
      gateway: { ...topo.gateway, policies: [{ kind: "ClientTrafficPolicy", namespace: "infra", name: "ctp", targetKind: "Gateway", targetNamespace: "infra", targetName: "eg", targetSectionName: "", summary: "http2", details: [], inferred: false, match: "" }] },
      routes: [{
        ...topo.routes[0],
        policies: [{ kind: "BackendTrafficPolicy", namespace: "apps", name: "btp", targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "", summary: "retries", details: [{ key: "retries", value: "3" }], inferred: false, match: "" }],
        services: [{ ...topo.routes[0].services[0], policies: [{ kind: "BackendTLSPolicy", namespace: "apps", name: "btls", targetKind: "Service", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "hostname", details: [], inferred: false, match: "" }] }],
      }],
      warnings: [],
    };
    seed(withPolicies);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/CTP/)).toBeTruthy();   // gateway header
    expect(getByText(/BTP/)).toBeTruthy();   // route box
    expect(getByText(/BTLS/)).toBeTruthy();  // service box
  });

  it("shows attached policies (with target + detail rows) in the route detail panel", () => {
    const withPolicies: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{
        ...topo.routes[0],
        policies: [{ kind: "BackendTrafficPolicy", namespace: "apps", name: "backend-retries", targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "", summary: "retries + timeout", details: [{ key: "retries", value: "3" }, { key: "request timeout", value: "30s" }], inferred: false, match: "" }],
        services: [topo.routes[0].services[0]],
      }],
      warnings: [],
    };
    seed(withPolicies);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share")); // open the detail panel
    expect(getByText(/attached policies/i)).toBeTruthy();
    expect(getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "BackendTrafficPolicy apps/backend-retries")).toBeTruthy();
    expect(getByText((_, el) => el?.tagName === "DIV" && /^Target: HTTPRoute apps\/share/.test(el.textContent ?? ""))).toBeTruthy();
    expect(getByText(/request timeout/)).toBeTruthy();
    expect(getByText(/Gateway policies are shown in the topology header/i)).toBeTruthy();
  });

  it("renders inferred CNP chips on the pods box and cluster-wide CCNPs in the header", () => {
    const cnp = { kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow", targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "ingress", details: [], inferred: true, match: "selector" };
    const ccnp = { kind: "CiliumClusterwideNetworkPolicy", namespace: "", name: "cluster-deny", targetKind: "Pods", targetNamespace: "", targetName: "", targetSectionName: "", summary: "ingress default-deny", details: [], inferred: true, match: "cluster-wide" };
    const withCilium: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], cnps: [cnp] }] }],
      clusterPolicies: [ccnp],
      warnings: [],
    };
    seed(withCilium);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText("CNP")).toBeTruthy();          // pods box (exact - avoids matching "CCNP")
    expect(getByText(/cluster-wide policies/i)).toBeTruthy(); // header group label
    expect(getByText("CCNP")).toBeTruthy();         // header chip (exact)
  });

  it("route detail shows inferred CNPs with honest pod-target wording", () => {
    const cnp = { kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow", targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "ingress", details: [{ key: "L7", value: "http" }], inferred: true, match: "selector" };
    const withCilium: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], cnps: [cnp] }] }],
      warnings: [],
    };
    seed(withCilium);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share"));
    expect(getByText(/inferred network policies/i)).toBeTruthy();
    expect(getByText(/Pods selected via Service apps\/share-api/)).toBeTruthy();
    expect(getByText(/Inferred via: selector/)).toBeTruthy();
  });

  it("renders a ⇄ global cross-cluster edge on the pods box for a global service", () => {
    const withGlobal: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], global: true, meshClusters: ["homelab-orange"], meshUnconfirmed: false }] }],
      warnings: [],
    };
    seed(withGlobal);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    // Tightened from /global/i: the retired-placeholder caption also contains
    // "⇄ global …", so match the edge's distinctive peer arrow instead.
    expect(getByText(/⇄ global → homelab-orange/)).toBeTruthy();
    expect(getByText(/homelab-orange/)).toBeTruthy();
  });

  it("shows '(peers unverified)' when meshUnconfirmed and no confirmed peers", () => {
    const withGlobal: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], global: true, meshClusters: [], meshUnconfirmed: true }] }],
      warnings: [],
    };
    seed(withGlobal);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/peers unverified/i)).toBeTruthy();
  });

  it("no global edge for a non-global service", () => {
    seed(topo); // share-api global:false
    const { queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    // Tightened from /⇄ global/: the caption legitimately contains "⇄ global
    // services …"; match only the edge forms ("⇄ global →" / "⇄ global (").
    expect(queryByText(/⇄ global(?: →| \()/)).toBeNull();
  });
});
