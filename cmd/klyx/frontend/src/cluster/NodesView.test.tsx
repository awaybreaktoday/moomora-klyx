import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { NodesView } from "./NodesView";
import { useFleet } from "../store/fleet";
import type { NodeSummaryDTO, NodeDetailDTO } from "../store/fleet";

vi.mock("../bridge/nodes", () => ({
  listNodes: vi.fn().mockResolvedValue(undefined),
  openNodeDetail: vi.fn().mockResolvedValue(undefined),
}));
import { openNodeDetail } from "../bridge/nodes";

const healthy: NodeSummaryDTO = {
  name: "node-healthy",
  roles: ["worker"],
  ready: true,
  unschedulable: false,
  problems: [],
  version: "v1.30.0",
  os: "linux",
  arch: "amd64",
  taintCount: 0,
  cpuCapacity: 8,
  cpuAllocatable: 7.8,
  memCapacity: 16 * 1073741824,
  memAllocatable: 14 * 1073741824,
  podCapacity: 110,
  ageSeconds: 86400,
};

const notReady: NodeSummaryDTO = {
  name: "a-notready",
  roles: [],
  ready: false,
  unschedulable: false,
  problems: ["NotReady"],
  version: "v1.30.0",
  os: "linux",
  arch: "amd64",
  taintCount: 1,
  cpuCapacity: 4,
  cpuAllocatable: 3.8,
  memCapacity: 8 * 1073741824,
  memAllocatable: 7 * 1073741824,
  podCapacity: 110,
  ageSeconds: 3600,
};

const cordoned: NodeSummaryDTO = {
  name: "b-cordoned",
  roles: ["worker"],
  ready: true,
  unschedulable: true,
  problems: [],
  version: "v1.30.0",
  os: "linux",
  arch: "amd64",
  taintCount: 0,
  cpuCapacity: 4,
  cpuAllocatable: 4,
  memCapacity: 8 * 1073741824,
  memAllocatable: 8 * 1073741824,
  podCapacity: 110,
  ageSeconds: 7200,
};

const fakeDetail: NodeDetailDTO = {
  summary: healthy,
  labels: { "kubernetes.io/hostname": "node-healthy", region: "westeurope" },
  taints: [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }],
  conditions: [
    { type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status" },
    { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", message: "" },
  ],
  events: [
    { type: "Normal", reason: "Starting", message: "kubelet starting", count: 1, lastSeen: "2026-06-10T00:00:00Z" },
  ],
  yaml: "apiVersion: v1\nkind: Node",
  podsOnNode: [
    { namespace: "kube-system", name: "coredns-abc", phase: "Running" },
    { namespace: "monitoring", name: "prometheus-0", phase: "Running" },
  ],
};

function seed(items: NodeSummaryDTO[]) {
  useFleet.setState((s) => ({
    nodes: {
      ...s.nodes,
      cluster: "homelab",
      items,
      loading: false,
    },
  }));
}

describe("NodesView", () => {
  beforeEach(() => {
    useFleet.getState().clearNodes();
    vi.clearAllMocks();
  });

  it("renders rows from seeded store", () => {
    seed([notReady, healthy]);
    const { getByText } = render(<NodesView cluster="homelab" />);
    expect(getByText("node-healthy")).toBeTruthy();
    expect(getByText("a-notready")).toBeTruthy();
  });

  it("shows problem text for not-ready node", () => {
    seed([notReady]);
    const { getByText } = render(<NodesView cluster="homelab" />);
    expect(getByText("NotReady")).toBeTruthy();
  });

  it("shows cordoned text for unschedulable node", () => {
    seed([cordoned]);
    const { getByText } = render(<NodesView cluster="homelab" />);
    expect(getByText("cordoned")).toBeTruthy();
  });

  it("shows '-' roles for node with empty roles", () => {
    seed([notReady]); // notReady has roles: []
    const { getAllByText } = render(<NodesView cluster="homelab" />);
    // The roles cell for this node is "-"
    expect(getAllByText("-").length).toBeGreaterThan(0);
  });

  it("row click calls openNodeDetail", () => {
    seed([healthy]);
    const { getByText } = render(<NodesView cluster="homelab" />);
    fireEvent.click(getByText("node-healthy"));
    expect(openNodeDetail).toHaveBeenCalledWith("homelab", "node-healthy");
  });

  it("detail panel renders summary, conditions, taints, events", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getAllByText, getByText } = render(<NodesView cluster="homelab" />);
    // Summary — version appears in both list row and detail panel; use getAllByText
    expect(getAllByText("v1.30.0").length).toBeGreaterThanOrEqual(1);
    // Conditions
    expect(getByText("kubelet is posting ready status")).toBeTruthy();
    // Taints
    expect(getByText("dedicated")).toBeTruthy();
    expect(getByText("NoSchedule")).toBeTruthy();
    // Events
    expect(getByText("Starting")).toBeTruthy();
  });

  it("detail panel shows pods-on-node list", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<NodesView cluster="homelab" />);
    expect(getByText("coredns-abc")).toBeTruthy();
    expect(getByText("prometheus-0")).toBeTruthy();
  });

  it("labels section is collapsed by default, expandable", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText, queryByText } = render(<NodesView cluster="homelab" />);
    // Labels collapsed: values not visible
    expect(queryByText(/kubernetes\.io\/hostname=node-healthy/)).toBeNull();
    // Click expand
    fireEvent.click(getByText("expand"));
    expect(getByText(/kubernetes\.io\/hostname=node-healthy/)).toBeTruthy();
  });

  it("yaml tab renders yaml content", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<NodesView cluster="homelab" />);
    fireEvent.click(getByText("yaml"));
    expect(getByText(/apiVersion: v1/)).toBeTruthy();
  });

  it("close button clears selected node", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<NodesView cluster="homelab" />);
    fireEvent.click(getByText("✕"));
    expect(useFleet.getState().nodes.selected).toBeNull();
  });

  it("pods-on-node click navigates to pods section", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      nodes: {
        ...s.nodes,
        selected: { name: "node-healthy" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    // Set up cluster route
    useFleet.getState().openCluster("homelab");
    const { getByText } = render(<NodesView cluster="homelab" />);
    fireEvent.click(getByText("coredns-abc"));
    expect(useFleet.getState().route).toMatchObject({ section: "pods" });
  });
});
