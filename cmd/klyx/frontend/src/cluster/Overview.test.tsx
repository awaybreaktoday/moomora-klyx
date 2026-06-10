import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Overview } from "./Overview";
import { useFleet } from "../store/fleet";
import type { ClusterDTO, MetricsDTO, OverviewSummary } from "../store/fleet";

vi.mock("../bridge/metrics", () => ({ getClusterMetrics: vi.fn() }));
vi.mock("../bridge/overview", () => ({ fetchOverviewSummary: vi.fn().mockResolvedValue(undefined) }));

const dto: ClusterDTO = {
  name: "homelab-nelli", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 58,
  version: "v1.36.1", gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "homelab", region: "", provider: "k3s", group: "", ageSeconds: 3,
};

const blue: ClusterDTO = { ...dto, name: "homelab-blue" };

function setMetrics(d: MetricsDTO | null) {
  useFleet.setState({ metrics: { cluster: "homelab-blue", dto: d, loading: false } });
}

function seedSummary(cluster: string, partial: Partial<OverviewSummary> = {}) {
  useFleet.setState({
    overviewSummary: {
      cluster,
      loading: false,
      unhealthyWorkloads: 0,
      podsNotReady: 0,
      warningEvents: 0,
      nodeProblems: 0,
      helmAvailable: false,
      failedReleases: null,
      namespaces: null,
      ...partial,
    },
  });
}

describe("Overview", () => {
  beforeEach(() => {
    useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } });
    useFleet.getState().clearOverviewSummary();
  });

  it("renders summary fields from the DTO", () => {
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("homelab-nelli")).toBeTruthy();
    expect(getByText("v1.36.1")).toBeTruthy();
    expect(getByText("1/1")).toBeTruthy();
    expect(getByText("58")).toBeTruthy();
    expect(getByText("homelab")).toBeTruthy();
  });
  it("shows the reason for a failed cluster", () => {
    const { getByText } = render(<Overview c={{ ...dto, state: "Failed", reason: "connect timed out" }} />);
    expect(getByText(/connect timed out/i)).toBeTruthy();
  });
});

describe("Overview metrics", () => {
  beforeEach(() => {
    useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } });
    useFleet.getState().clearOverviewSummary();
  });

  it("renders cpu/mem percents and the discovered monitoring line", () => {
    setMetrics({ available: true, mode: "discovered-service", source: "monitoring/prometheus-operated:9090", warning: "", reason: "", cpuFraction: 0.38, memFraction: 0.61 });
    const { getByText } = render(<Overview c={blue} />);
    expect(getByText("38%")).toBeTruthy();
    expect(getByText("61%")).toBeTruthy();
    expect(getByText(/monitoring: discovered · svc monitoring\/prometheus-operated:9090/)).toBeTruthy();
  });

  it("renders — for null fractions", () => {
    setMetrics({ available: true, mode: "explicit-endpoint", source: "https://h", warning: "", reason: "", cpuFraction: null, memFraction: null });
    const { getAllByText } = render(<Overview c={blue} />);
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the unavailable reason", () => {
    setMetrics({ available: false, mode: "unavailable", source: "", warning: "", reason: "multiple candidate Services found, set metrics.serviceRef", cpuFraction: null, memFraction: null });
    const { getByText } = render(<Overview c={blue} />);
    expect(getByText(/monitoring unavailable: multiple candidate Services found/)).toBeTruthy();
  });
});

// ---- Attention strip ---------------------------------------------------------

describe("Overview attention strip", () => {
  beforeEach(() => {
    useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } });
    useFleet.getState().clearOverviewSummary();
  });

  it("shows — (muted) for all tiles while loading", () => {
    useFleet.setState({ overviewSummary: { cluster: "homelab-nelli", loading: true, unhealthyWorkloads: null, podsNotReady: null, warningEvents: null, nodeProblems: null, helmAvailable: false, failedReleases: null, namespaces: null } });
    const { getAllByText } = render(<Overview c={dto} />);
    // During loading, all tiles show "—".
    const dashes = getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(4); // 4 always-visible tiles + usage dashes
  });

  it("renders non-zero counts as numbers", () => {
    seedSummary("homelab-nelli", { unhealthyWorkloads: 3, podsNotReady: 1, warningEvents: 5, nodeProblems: 0 });
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("3")).toBeTruthy();
    expect(getByText("1")).toBeTruthy();
    expect(getByText("5")).toBeTruthy();
  });

  it("zero counts render as '0' (quiet, not hidden)", () => {
    seedSummary("homelab-nelli", { unhealthyWorkloads: 0, podsNotReady: 0, warningEvents: 0, nodeProblems: 0 });
    const { getAllByText } = render(<Overview c={dto} />);
    const zeros = getAllByText("0");
    expect(zeros.length).toBeGreaterThanOrEqual(4);
  });

  it("navigates to workloads and sets needs-attention on tile click", () => {
    useFleet.getState().openCluster("homelab-nelli");
    seedSummary("homelab-nelli", { unhealthyWorkloads: 2 });
    const { getByText } = render(<Overview c={dto} />);
    fireEvent.click(getByText("unhealthy workloads"));
    const state = useFleet.getState();
    expect(state.route).toMatchObject({ name: "cluster", section: "workloads" });
    expect(state.workloads.needsAttention).toBe(true);
  });

  it("navigates to pods and sets needs-attention on tile click", () => {
    useFleet.getState().openCluster("homelab-nelli");
    seedSummary("homelab-nelli", { podsNotReady: 1 });
    const { getByText } = render(<Overview c={dto} />);
    fireEvent.click(getByText("pods not ready"));
    const state = useFleet.getState();
    expect(state.route).toMatchObject({ name: "cluster", section: "pods" });
    expect(state.pods.needsAttention).toBe(true);
  });

  it("navigates to events and enables warnings-only on tile click", () => {
    useFleet.getState().openCluster("homelab-nelli");
    seedSummary("homelab-nelli", { warningEvents: 7 });
    const { getByText } = render(<Overview c={dto} />);
    fireEvent.click(getByText("warning events"));
    const state = useFleet.getState();
    expect(state.route).toMatchObject({ name: "cluster", section: "events" });
    expect(state.events.warningsOnly).toBe(true);
  });

  it("helm tile is hidden when helmAvailable=false", () => {
    seedSummary("homelab-nelli", { helmAvailable: false, failedReleases: null });
    const { queryByText } = render(<Overview c={dto} />);
    expect(queryByText("failed releases")).toBeNull();
  });

  it("helm tile is visible when helmAvailable=true", () => {
    seedSummary("homelab-nelli", { helmAvailable: true, failedReleases: 0 });
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("failed releases")).toBeTruthy();
  });

  it("shows — with title='failed to load' when a tile has null count after load", () => {
    seedSummary("homelab-nelli", { unhealthyWorkloads: null });
    const { getByTitle } = render(<Overview c={dto} />);
    expect(getByTitle("failed to load")).toBeTruthy();
  });
});

// ---- Capacity namespaces row ---------------------------------------------------

describe("Overview capacity namespace row", () => {
  beforeEach(() => {
    useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } });
    useFleet.getState().clearOverviewSummary();
  });

  it("shows namespace count in Capacity when summary is loaded", () => {
    seedSummary("homelab-nelli", { namespaces: 7 });
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("7")).toBeTruthy();
    expect(getByText("namespaces")).toBeTruthy();
  });

  it("omits namespace row when namespaces is null (not yet loaded)", () => {
    seedSummary("homelab-nelli", { namespaces: null });
    const { queryByText } = render(<Overview c={dto} />);
    expect(queryByText("namespaces")).toBeNull();
  });
});
