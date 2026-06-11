import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  useFleet.setState({
    clusters: [],
    route: { name: "fleet" },
    crd: { cluster: null, groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "", builtinCategory: null },
  });
});

// --- legacy nav tests (preserved) ---

describe("Sidebar nav", () => {
  it("Fleet button returns to the grid", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("Fleet").click();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });

  it("a section button is disabled at the fleet root", () => {
    const { getByLabelText } = render(<Sidebar />);
    expect((getByLabelText("Flux") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a section button sets the section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("Flux").click();
    expect(useFleet.getState().route).toMatchObject({ name: "cluster", section: "gitops" });
  });

  it("highlights the Overview button after openCluster", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    const overview = getByLabelText("Overview") as HTMLButtonElement;
    expect(overview.disabled).toBe(false);
    expect(overview.style.background).toContain("--color-background-primary");
  });
});

// --- daily-driver section order ---

describe("Sidebar section order", () => {
  it("renders sections in triage-first grouped order when expanded", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    const { getAllByRole } = render(<Sidebar />);
    // Collect visible text labels from buttons (expanded mode shows text spans).
    const buttons = getAllByRole("button");
    const labels = buttons
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    // Fleet is first; then the 10 sections (grouped); then Terminal, Settings, collapse sidebar.
    const expectedOrder = [
      "Fleet",
      "Forwards",
      "Overview",
      "Workloads", "Pods", "Events",
      "Flux", "Helm",
      "Network", "Nodes",
      "Resources", "CRDs",
      "Terminal", "Settings",
    ];
    expectedOrder.forEach((label, i) => {
      expect(labels[i]).toBe(label);
    });
  });

  it("gitops section button is labelled Flux (design principle 8)", () => {
    const { getByLabelText } = render(<Sidebar />);
    expect(getByLabelText("Flux")).toBeTruthy();
  });

  it("renders 4 dividers between the 5 section groups", () => {
    const { getAllByRole } = render(<Sidebar />);
    const dividers = getAllByRole("separator");
    expect(dividers).toHaveLength(4);
  });
});

// --- expand / collapse toggle ---

describe("Sidebar expand/collapse", () => {
  it("defaults to collapsed when no stored preference", () => {
    const { getByLabelText } = render(<Sidebar />);
    // In collapsed state the toggle button has label "expand sidebar"
    expect(getByLabelText("expand sidebar")).toBeTruthy();
  });

  it("restores expanded state when stored preference is '1'", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    const { getByLabelText } = render(<Sidebar />);
    expect(getByLabelText("collapse sidebar")).toBeTruthy();
  });

  it("clicking the toggle expands and persists '1' to localStorage", () => {
    const { getByLabelText } = render(<Sidebar />);
    fireEvent.click(getByLabelText("expand sidebar"));
    expect(localStorage.getItem("klyx-sidebar-expanded")).toBe("1");
    expect(getByLabelText("collapse sidebar")).toBeTruthy();
  });

  it("clicking the toggle again collapses and persists '0' to localStorage", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    const { getByLabelText } = render(<Sidebar />);
    fireEvent.click(getByLabelText("collapse sidebar"));
    expect(localStorage.getItem("klyx-sidebar-expanded")).toBe("0");
    expect(getByLabelText("expand sidebar")).toBeTruthy();
  });
});

// --- active state in expanded mode ---

describe("Sidebar active state", () => {
  it("active section label is medium-weight in expanded mode", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    const overview = getByLabelText("Overview") as HTMLButtonElement;
    // The label <span> inside the active button should have fontWeight 500.
    const labelSpan = overview.querySelector("span:last-child") as HTMLElement;
    expect(labelSpan.style.fontWeight).toBe("500");
  });

  it("inactive section label is normal weight in expanded mode", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    const workloads = getByLabelText("Workloads") as HTMLButtonElement;
    const labelSpan = workloads.querySelector("span:last-child") as HTMLElement;
    expect(labelSpan.style.fontWeight).toBe("400");
  });
});

// --- category sub-nav ---

describe("Sidebar category sub-nav", () => {
  it("expanded + resources active shows six category sub-items", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("resources");
    const { getByLabelText } = render(<Sidebar />);
    expect(getByLabelText("category Workloads")).toBeTruthy();
    expect(getByLabelText("category Config")).toBeTruthy();
    expect(getByLabelText("category Network")).toBeTruthy();
    expect(getByLabelText("category Storage")).toBeTruthy();
    expect(getByLabelText("category Cluster")).toBeTruthy();
    expect(getByLabelText("category Access")).toBeTruthy();
  });

  it("clicking a sub-item sets builtinCategory in the store", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("resources");
    const setBuiltinCategory = vi.spyOn(useFleet.getState(), "setBuiltinCategory");
    const { getByLabelText } = render(<Sidebar />);
    fireEvent.click(getByLabelText("category Config"));
    expect(useFleet.getState().crd.builtinCategory).toBe("Config");
    setBuiltinCategory.mockRestore();
  });

  it("collapsed mode does not show sub-items even when resources is active", () => {
    // Default is collapsed (no localStorage entry)
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("resources");
    const { queryByLabelText } = render(<Sidebar />);
    expect(queryByLabelText("category Config")).toBeNull();
  });

  it("expanded + non-resources section active does not show sub-items", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("workloads");
    const { queryByLabelText } = render(<Sidebar />);
    expect(queryByLabelText("category Config")).toBeNull();
  });

  it("active category sub-item gets active background when builtinCategory matches", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("resources");
    useFleet.setState({ crd: { ...useFleet.getState().crd, builtinCategory: "Config" } });
    const { getByLabelText } = render(<Sidebar />);
    const btn = getByLabelText("category Config") as HTMLButtonElement;
    expect(btn.style.background).toContain("--color-background-primary");
  });

  it("no sub-item highlighted when builtinCategory is null", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("resources");
    const { getByLabelText } = render(<Sidebar />);
    const btn = getByLabelText("category Config") as HTMLButtonElement;
    // background should be transparent (not the active color)
    expect(btn.style.background).toBe("transparent");
  });
});
