import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, CRDGroupDTO, crdCountKey } from "../store/fleet";
import { CRDBrowser } from "./CRDBrowser";

vi.mock("../bridge/crd", () => ({
  listCRDs: vi.fn(async () => {}),
  countKind: vi.fn(async () => {}),
}));
import { countKind } from "../bridge/crd";

const groups: CRDGroupDTO[] = [
  { group: "cilium.io", category: "CNI", kinds: [
    { kind: "CiliumEndpoint", plural: "ciliumendpoints", scope: "Namespaced", version: "v2", operator: "cilium", shortNames: ["cep"] },
    { kind: "CiliumNode", plural: "ciliumnodes", scope: "Cluster", version: "v2", operator: "cilium", shortNames: [] },
  ] },
  { group: "cert-manager.io", category: "PKI", kinds: [
    { kind: "Certificate", plural: "certificates", scope: "Namespaced", version: "v1", operator: "cert-manager", shortNames: ["cert"] },
  ] },
];

beforeEach(() => useFleet.setState({
  crd: { cluster: "x", groups, loading: false, expanded: [], counts: {}, groupBy: "group", search: "" },
}));

describe("CRDBrowser - CRD groups", () => {
  it("renders groups with category badges", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("cilium.io")).toBeTruthy();
    expect(getByText("CNI")).toBeTruthy();
    expect(getByText("cert-manager.io")).toBeTruthy();
  });

  it("expands a group, shows kinds, and fires countKind", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    fireEvent.click(getByText("cilium.io"));
    expect(getByText("CiliumEndpoint")).toBeTruthy();
    expect(countKind).toHaveBeenCalledWith("x", "cilium.io", "v2", "ciliumendpoints");
  });

  it("renders 500+ when a count is capped", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, expanded: ["cilium.io"], counts: { [crdCountKey("cilium.io", "v2", "ciliumendpoints")]: { count: 500, capped: true } } } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("500+")).toBeTruthy();
  });

  it("regroups by scope", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, groupBy: "scope" } });
    const { getAllByText } = render(<CRDBrowser cluster="x" />);
    expect(getAllByText("Cluster").length).toBeGreaterThan(0);
    expect(getAllByText("Namespaced").length).toBeGreaterThan(0);
  });

  it("shows the empty state when there are no CRDs and search matches nothing", () => {
    // A search term that matches no CRD and no builtin kind renders the empty state.
    useFleet.setState({ crd: { ...useFleet.getState().crd, groups: [], search: "zzznomatch" } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText(/No custom resources/i)).toBeTruthy();
  });

  it("clicking a kind opens the resource drill-in", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" }, crd: { ...useFleet.getState().crd, expanded: ["cilium.io"] } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    fireEvent.click(getByText("CiliumEndpoint"));
    const r = useFleet.getState().route;
    expect(r.name === "cluster" && r.resource?.kind).toBe("CiliumEndpoint");
    expect(r.name === "cluster" && r.resource?.plural).toBe("ciliumendpoints");
  });
});

describe("CRDBrowser - Built-in catalog", () => {
  it("renders the Built-in section header", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("Built-in")).toBeTruthy();
  });

  it("renders expected builtin categories", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("Workloads")).toBeTruthy();
    expect(getByText("Config")).toBeTruthy();
    expect(getByText("Network")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("Cluster")).toBeTruthy();
    expect(getByText("Access")).toBeTruthy();
  });

  it("renders builtin kind names inside their categories", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(getByText("Secret")).toBeTruthy();
    expect(getByText("Service")).toBeTruthy();
    expect(getByText("Namespace")).toBeTruthy();
  });

  it("clicking ConfigMap navigates with the correct ResourceRef", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    fireEvent.click(getByText("ConfigMap"));
    const r = useFleet.getState().route;
    expect(r.name).toBe("cluster");
    if (r.name === "cluster") {
      expect(r.resource?.kind).toBe("ConfigMap");
      expect(r.resource?.plural).toBe("configmaps");
      expect(r.resource?.group).toBe("");
      expect(r.resource?.version).toBe("v1");
      expect(r.resource?.scope).toBe("Namespaced");
    }
  });

  it("clicking a Cluster-scoped builtin navigates with scope=Cluster", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    fireEvent.click(getByText("Namespace"));
    const r = useFleet.getState().route;
    if (r.name === "cluster") {
      expect(r.resource?.kind).toBe("Namespace");
      expect(r.resource?.scope).toBe("Cluster");
    }
  });

  it("search filters builtin rows - matching kind visible, others hidden", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap" } });
    const { getByText, queryByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    // Secret should not appear when searching for configmap
    expect(queryByText("Secret")).toBeNull();
  });

  it("search filters builtin categories - empty categories are hidden", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap" } });
    const { queryByText } = render(<CRDBrowser cluster="x" />);
    // "Storage" category has no match for "configmap"
    expect(queryByText("Storage")).toBeNull();
  });

  it("builtin counts are loaded lazily via countKind", () => {
    const mockCountKind = countKind as ReturnType<typeof vi.fn>;
    mockCountKind.mockClear();
    render(<CRDBrowser cluster="x" />);
    // countKind should have been called for at least one builtin (ConfigMap)
    expect(mockCountKind).toHaveBeenCalledWith("x", "", "v1", "configmaps");
  });

  it("builtin renders existing count from store", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, counts: { [crdCountKey("", "v1", "configmaps")]: { count: 42, capped: false } } } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("42")).toBeTruthy();
  });

  it("search also filters CRD groups - cert-manager visible but cilium hidden", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "certificate" } });
    const { queryByText } = render(<CRDBrowser cluster="x" />);
    expect(queryByText("cilium.io")).toBeNull();
    expect(queryByText("cert-manager.io")).toBeTruthy();
  });
});
