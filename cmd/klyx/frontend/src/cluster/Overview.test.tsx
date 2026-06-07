import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { Overview } from "./Overview";
import { useFleet } from "../store/fleet";
import type { ClusterDTO, MetricsDTO } from "../store/fleet";

vi.mock("../bridge/metrics", () => ({ getClusterMetrics: vi.fn() }));

const dto: ClusterDTO = {
  name: "homelab-nelli", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 58,
  version: "v1.36.1", gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "homelab", region: "", provider: "k3s", group: "", ageSeconds: 3,
};

const blue: ClusterDTO = { ...dto, name: "homelab-blue" };

function setMetrics(d: MetricsDTO | null) {
  useFleet.setState({ metrics: { cluster: "homelab-blue", dto: d, loading: false } });
}

describe("Overview", () => {
  beforeEach(() => useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } }));

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
  beforeEach(() => useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } }));

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
