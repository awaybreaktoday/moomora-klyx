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
  crd: { cluster: "x", groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "", builtinCategory: null },
  route: { name: "cluster", cluster: "x", section: "resources" },
}));

describe("BuiltinsView - catalog rendering", () => {
  it("renders expected builtin categories", () => {
    const { getAllByText } = render(<BuiltinsView cluster="x" />);
    // each category label appears as a chip button AND as a section header
    expect(getAllByText("Workloads").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Config").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Network").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Storage").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Cluster").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Access").length).toBeGreaterThanOrEqual(1);
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
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap", builtinCategory: null } });
    const { getByText, queryByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(queryByText("Secret")).toBeNull();
  });

  it("search filters builtin categories - empty category sections are hidden (StorageClass not shown)", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "configmap", builtinCategory: null } });
    const { queryByText } = render(<BuiltinsView cluster="x" />);
    // StorageClass is a kind only in Storage category; it should be absent when search filters it out
    expect(queryByText("StorageClass")).toBeNull();
  });

  it("shows empty state when search matches nothing", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "zzznomatch", builtinCategory: null } });
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
    useFleet.setState({ crd: { ...useFleet.getState().crd, counts: { [crdCountKey("", "v1", "configmaps")]: { count: 42, capped: false } }, builtinCategory: null } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("42")).toBeTruthy();
  });

  it("renders capped count with + suffix", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, counts: { [crdCountKey("", "v1", "configmaps")]: { count: 500, capped: true } }, builtinCategory: null } });
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

describe("BuiltinsView - category chips", () => {
  it("renders all category chips and the all chip", () => {
    const { getByText, getAllByRole } = render(<BuiltinsView cluster="x" />);
    // "all" chip - unique label
    expect(getByText("all")).toBeTruthy();
    // six category chip buttons exist (each category label maps to a chip button)
    const buttons = getAllByRole("button");
    const buttonLabels = buttons.map((b) => b.textContent?.trim()).filter(Boolean);
    expect(buttonLabels).toContain("Workloads");
    expect(buttonLabels).toContain("Config");
    expect(buttonLabels).toContain("Network");
    expect(buttonLabels).toContain("Storage");
    expect(buttonLabels).toContain("Cluster");
    expect(buttonLabels).toContain("Access");
  });

  it("selecting Config chip shows only ConfigMap and Secret rows", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config" } });
    const { getByText, queryByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(getByText("Secret")).toBeTruthy();
    expect(queryByText("Service")).toBeNull();
    expect(queryByText("Job")).toBeNull();
  });

  it("clicking Config chip sets builtinCategory to Config", () => {
    const { getAllByText } = render(<BuiltinsView cluster="x" />);
    // Config appears as a chip button and as a category header; click the first one (the chip)
    fireEvent.click(getAllByText("Config")[0]);
    expect(useFleet.getState().crd.builtinCategory).toBe("Config");
  });

  it("clicking the active Config chip clears the filter back to null", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config" } });
    const { getAllByText } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getAllByText("Config")[0]);
    expect(useFleet.getState().crd.builtinCategory).toBeNull();
  });

  it("clicking all chip clears the filter", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config" } });
    const { getByText } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getByText("all"));
    expect(useFleet.getState().crd.builtinCategory).toBeNull();
  });

  it("search composes with category filter - only matching kinds in category shown", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config", search: "configmap" } });
    const { getByText, queryByText } = render(<BuiltinsView cluster="x" />);
    expect(getByText("ConfigMap")).toBeTruthy();
    expect(queryByText("Secret")).toBeNull();
  });

  it("all chip restores all categories when category was set", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config" } });
    const { getByText, queryByText: _ } = render(<BuiltinsView cluster="x" />);
    fireEvent.click(getByText("all"));
    // Re-render is synchronous via Zustand; re-query
    expect(useFleet.getState().crd.builtinCategory).toBeNull();
  });
});
