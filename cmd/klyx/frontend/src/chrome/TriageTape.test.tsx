import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TriageTape } from "./TriageTape";
import { useFleet } from "../store/fleet";
import type { TapeCounts } from "../store/fleet";

vi.mock("../bridge/tape", () => ({ fetchTape: vi.fn().mockResolvedValue(undefined) }));
import { fetchTape } from "../bridge/tape";

const quiet: TapeCounts = { workloads: 0, pods: 0, events: 0, nodes: 0, helm: 0, flux: 0, argo: 0 };

function seed(counts: Partial<TapeCounts>) {
  useFleet.setState({ tape: { cluster: "nelli", loading: false, counts: { ...quiet, ...counts } } });
}

describe("TriageTape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFleet.getState().clearTape();
    useFleet.setState({ route: { name: "cluster", cluster: "nelli", section: "pods" } });
  });

  it("fetches once per cluster entry", () => {
    seed({});
    render(<TriageTape cluster="nelli" />);
    expect(fetchTape).toHaveBeenCalledWith("nelli");
  });

  it("all-zero counts state 'everything is quiet' with no chips", () => {
    seed({});
    const { getByText, queryByRole } = render(<TriageTape cluster="nelli" />);
    expect(getByText("everything is quiet")).toBeTruthy();
    expect(queryByRole("button")).toBeNull();
  });

  it("nonzero counts render chips; click jumps to the filtered lens", () => {
    seed({ workloads: 1, events: 3 });
    const { getByRole, getByText } = render(<TriageTape cluster="nelli" />);
    expect(getByText("everything else is quiet")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "1 unhealthy workloads" }));
    const st = useFleet.getState();
    expect(st.route).toMatchObject({ name: "cluster", section: "workloads" });
    expect(st.workloads.needsAttention).toBe(true);
  });

  it("argo chip navigates to the argo section", () => {
    seed({ argo: 2 });
    const { getByRole } = render(<TriageTape cluster="nelli" />);
    fireEvent.click(getByRole("button", { name: "2 argo not synced" }));
    expect(useFleet.getState().route).toMatchObject({ section: "argo" });
  });

  it("unreadable lenses are never claimed quiet", () => {
    useFleet.setState({ tape: { cluster: "nelli", loading: false, counts: { workloads: null, pods: null, events: null, nodes: null, helm: null, flux: null, argo: null } } });
    const { getByText } = render(<TriageTape cluster="nelli" />);
    expect(getByText("triage unavailable")).toBeTruthy();
  });

  it("partially readable shows alerts + 'some lenses unreadable'", () => {
    useFleet.setState({ tape: { cluster: "nelli", loading: false, counts: { workloads: 2, pods: null, events: 0, nodes: null, helm: null, flux: 0, argo: null } } });
    const { getByText, getByRole } = render(<TriageTape cluster="nelli" />);
    expect(getByRole("button", { name: "2 unhealthy workloads" })).toBeTruthy();
    expect(getByText("some lenses unreadable")).toBeTruthy();
  });
});
