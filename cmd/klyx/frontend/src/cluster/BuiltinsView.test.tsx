import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, crdCountKey } from "../store/fleet";
import { BuiltinsView } from "./BuiltinsView";

vi.mock("../bridge/crd", () => ({
  listCRDs: vi.fn(async () => {}),
  countKind: vi.fn(async () => {}),
}));
import { countKind } from "../bridge/crd";

beforeEach(() => useFleet.setState({
  crd: { cluster: "x", groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "" },
  route: { name: "cluster", cluster: "x", section: "resources" },
}));

describe("BuiltinsView - catalog rendering", () => {
  it("renders expected builtin categories", () => {
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("Workloads")).toBeTruthy();
    expect(getByText("Config")).toBeTruthy();
    expect(getByText("Network")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("Cluster")).toBeTruthy();
    expect(getByText("Access")).toBeTruthy();
  });

  it("renders builtin kind names inside their categories", () => {
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(getByText("Secret")).toBeTruthy();
    expect(getByText("Service")).toBeTruthy();
    expect(getByText("Namespace")).toBeTruthy();
  });

  it("clicking ConfigMap navigates with the correct ResourceRef under resources section", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getByText("ConfigMap"));
    const r = useFleet.getState().route;
    expect(r.name).toBe("cluster");
    if (r.name === "cluster") {
      expect(r.section).toBe("resources");
      expect(r.resource?.kind).toBe("ConfigMap");
      expect(r.resource?.plural).toBe("configmaps");
      expect(r.resource?.group).toBe("");
      expect(r.resource?.version).toBe("v1");
      expect(r.resource?.scope).toBe("Namespaced");
    }
  });

  it("clicking a Cluster-scoped builtin navigates with scope=Cluster", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getByText("Namespace"));
    const r = useFleet.getState().route;
    if (r.name === "cluster") {
      expect(r.resource?.kind).toBe("Namespace");
      expect(r.resource?.scope).toBe("Cluster");
    }
  });

  it("search filters builtin rows - matching kind visible, others hidden", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap" } });
    const { getByText, queryByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(queryByText("Secret")).toBeNull();
  });

  it("search filters builtin categories - empty categories are hidden", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap" } });
    const { queryByText } = render(<BuiltinsView cluster="x" />);
    expect(queryByText("Storage")).toBeNull();
  });

  it("shows empty state when search matches nothing", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "zzznomatch" } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText(/No built-in resources match/i)).toBeTruthy();
  });

  it("builtin counts are loaded lazily via countKind", () => {
    const mockCountKind = countKind as ReturnType<typeof vi.fn>;
    mockCountKind.mockClear();
    render(<BuiltinsView cluster="x" />);
    expect(mockCountKind).toHaveBeenCalledWith("x", "", "v1", "configmaps");
  });

  it("builtin renders existing count from store", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, counts: { [crdCountKey("", "v1", "configmaps")]: { count: 42, capped: false } } } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("42")).toBeTruthy();
  });

  it("renders capped count with + suffix", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, counts: { [crdCountKey("", "v1", "configmaps")]: { count: 500, capped: true } } } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("500+")).toBeTruthy();
  });
});

describe("BuiltinsView - drill from crds section", () => {
  it("clicking a kind from the crds section opens resource drill within crds section", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "crds" } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getByText("ConfigMap"));
    const r = useFleet.getState().route;
    if (r.name === "cluster") {
      expect(r.section).toBe("crds");
      expect(r.resource?.kind).toBe("ConfigMap");
    }
  });
});
