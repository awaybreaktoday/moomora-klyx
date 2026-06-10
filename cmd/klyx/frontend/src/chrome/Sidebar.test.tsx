import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  useFleet.setState({ clusters: [], route: { name: "fleet" } });
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
    expect((getByLabelText("GitOps") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a section button sets the section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("GitOps").click();
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
  it("renders sections in daily-driver triage order when expanded", () => {
    localStorage.setItem("klyx-sidebar-expanded", "1");
    const { getAllByRole } = render(<Sidebar />);
    // Collect visible text labels from buttons (expanded mode shows text spans).
    const buttons = getAllByRole("button");
    const labels = buttons
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    // Fleet is first; then the 11 sections; then Terminal, Settings, collapse sidebar.
    const expectedOrder = [
      "Fleet",
      "Overview", "Workloads", "Pods", "Events", "Nodes",
      "Resources", "CRDs", "Network", "GitOps", "Helm", "Observability",
      "Terminal", "Settings",
    ];
    expectedOrder.forEach((label, i) => {
      expect(labels[i]).toBe(label);
    });
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
