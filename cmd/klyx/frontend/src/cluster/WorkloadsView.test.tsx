import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { WorkloadsView } from "./WorkloadsView";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO } from "../store/fleet";

vi.mock("../bridge/workloads", () => ({
  listWorkloads: vi.fn().mockResolvedValue(undefined),
  openLiveWorkloads: vi.fn().mockReturnValue(() => {}),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
  scaleWorkload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../bridge/workload-metrics", () => ({ getWorkloadMetrics: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../bridge/windows", () => ({ openWorkloadLogsWindow: vi.fn().mockResolvedValue(true) }));
// Stub LogsPane — its real implementation drags in the Wails runtime and the
// stream lifecycle, both covered by LogsPane.test.tsx. Here we only assert the
// dock plumbing: what target it gets and in which mode.
vi.mock("./LogsPane", () => ({
  LogsPane: ({ pod, workload }: { pod: { namespace: string; name: string }; workload?: { kind: string; name: string } }) => (
    <div data-testid="logs-pane-stub">{workload ? `${workload.kind}:${pod.namespace}/${workload.name}` : `pod:${pod.namespace}/${pod.name}`}</div>
  ),
}));
import { rolloutRestart, scaleWorkload, openLiveWorkloads } from "../bridge/workloads";
import { openWorkloadLogsWindow } from "../bridge/windows";

const noResources = { cpu: { usage: null, request: null, limit: null }, mem: { usage: null, request: null, limit: null } };
const broken: WorkloadDTO = { kind: "Deployment", namespace: "ollama-prod", name: "ollama", desired: 1, ready: 0, available: 0, updated: 1, restarts: 7, reason: "CrashLoopBackOff", rank: "unhealthy", gitops: { kind: "Kustomization", namespace: "flux-system", name: "ollama" }, pods: [{ name: "ollama-x", ready: false, restarts: 7, reason: "CrashLoopBackOff", node: "node-3", ageSeconds: 720 }], resources: noResources };
const healthy: WorkloadDTO = { kind: "Deployment", namespace: "monitoring", name: "grafana", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "Available", rank: "healthy", gitops: null, pods: [], resources: noResources };

function seed(items: WorkloadDTO[]) {
  useFleet.setState((s) => ({ workloads: { ...s.workloads, cluster: "homelab-nelli", items, namespaces: ["monitoring", "ollama-prod"], loading: false } }));
}

describe("WorkloadsView", () => {
  beforeEach(() => useFleet.getState().clearWorkloads());

  it("renders triage rows with reason, restarts, and gitops owner", () => {
    seed([broken, healthy]);
    const { getByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(getByText("CrashLoopBackOff")).toBeTruthy();
    expect(getByText("flux ks/ollama")).toBeTruthy();
    expect(getByText("0 / 1")).toBeTruthy();
  });

  it("expands a row to show its pods", () => {
    seed([broken]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("ollama-x")).toBeNull();
    fireEvent.click(getByText("ollama"));
    expect(getByText("ollama-x")).toBeTruthy();
    expect(getByText("node-3")).toBeTruthy();
  });

  it("needs-attention filter hides healthy rows", () => {
    seed([broken, healthy]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText(/needs attention/i));
    expect(getByText("ollama")).toBeTruthy();
    expect(queryByText("grafana")).toBeNull();
  });

  it("hides cpu/mem columns and near-limit control when metrics unavailable", () => {
    seed([broken, healthy]);
    // metricsAvailable stays false (default store state)
    const { queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("near limit")).toBeNull();
    expect(queryByText("cpu")).toBeNull();
    expect(queryByText("mem")).toBeNull();
  });

  it("shows cpu/mem columns and near-limit control when metrics available", () => {
    seed([broken, healthy]);
    // Call setWorkloadUsage with an available result so metricsAvailable becomes true
    useFleet.getState().setWorkloadUsage("homelab-nelli", "", {
      status: { available: true, message: "", updatedAt: "2026-06-09T00:00:00Z" },
      usage: {},
    });
    const { getByText, getAllByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(getByText("near limit")).toBeTruthy();
    expect(getAllByText("cpu").length).toBeGreaterThan(0);
    expect(getAllByText("mem").length).toBeGreaterThan(0);
  });

  it("restart button is visible after expanding a Deployment row", () => {
    seed([broken]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("restart")).toBeNull();
    fireEvent.click(getByText("ollama")); // expand the row
    expect(getByText("restart")).toBeTruthy();
  });

  it("confirming restart dispatches rolloutRestart for the correct workload", () => {
    seed([broken]);
    const { getByText, getAllByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("ollama")); // expand
    fireEvent.click(getByText("restart")); // open confirm dialog
    const confirmBtns = getAllByRole("button", { name: "Restart" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]); // confirm
    expect(rolloutRestart).toHaveBeenCalledWith("homelab-nelli", "Deployment", "ollama-prod", "ollama");
  });

  // --- Scale button ---

  it("scale button is visible after expanding a Deployment row", () => {
    seed([broken]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("scale")).toBeNull();
    fireEvent.click(getByText("ollama")); // expand
    expect(getByText("scale")).toBeTruthy();
  });

  it("scale button is hidden for DaemonSets", () => {
    const daemonSet: WorkloadDTO = {
      kind: "DaemonSet", namespace: "kube-system", name: "cilium",
      desired: 3, ready: 3, available: 3, updated: 3, restarts: 0,
      reason: "Available", rank: "healthy", gitops: null, pods: [], resources: noResources,
    };
    seed([daemonSet]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("cilium")); // expand
    expect(queryByText("scale")).toBeNull();
    expect(getByText("restart")).toBeTruthy(); // restart still shown
  });

  it("scale button is visible for StatefulSets", () => {
    const sts: WorkloadDTO = {
      kind: "StatefulSet", namespace: "db", name: "postgres",
      desired: 1, ready: 1, available: 1, updated: 1, restarts: 0,
      reason: "Available", rank: "healthy", gitops: null, pods: [], resources: noResources,
    };
    seed([sts]);
    const { getByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("postgres")); // expand
    expect(getByText("scale")).toBeTruthy();
  });

  it("clicking scale shows the replica input popover prefilled with desired count", () => {
    seed([broken]); // broken.desired = 1
    const { getByText, getByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("ollama")); // expand
    fireEvent.click(getByText("scale")); // open popover
    const input = getByRole("spinbutton", { name: /replica count/i });
    expect((input as HTMLInputElement).value).toBe("1");
  });

  it("confirming scale dispatches scaleWorkload with the entered replica count", () => {
    seed([broken]);
    const { getByText, getByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("ollama")); // expand
    fireEvent.click(getByText("scale")); // open popover
    const input = getByRole("spinbutton", { name: /replica count/i });
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(getByText("✓")); // confirm in popover
    expect(scaleWorkload).toHaveBeenCalledWith("homelab-nelli", "Deployment", "ollama-prod", "ollama", 3);
  });

  // --- Keyboard nav + a11y ---

  it("j then Enter expands the second row", () => {
    const second: WorkloadDTO = {
      kind: "Deployment", namespace: "default", name: "second-workload",
      desired: 1, ready: 1, available: 1, updated: 1, restarts: 0,
      reason: "Available", rank: "healthy", gitops: null, pods: [], resources: noResources,
    };
    seed([broken, second]);
    const { queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("second-workload")).toBeTruthy();
    // j → index 0; wait for re-render; j → index 1; Enter → expand second row
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    // The "restart" button appears in the expanded section
    expect(queryByText("restart")).toBeTruthy();
  });

  it("/ focuses the filter input", () => {
    seed([broken]);
    const { getByPlaceholderText } = render(<WorkloadsView cluster="homelab-nelli" />);
    const input = getByPlaceholderText("filter workloads") as HTMLInputElement;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    expect(input).toBeTruthy();
  });

  it("workload row has role=button and aria-expanded", () => {
    seed([broken]);
    const { getAllByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    const rows = getAllByRole("button").filter((el) => el.hasAttribute("aria-expanded"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
  });

  it("workload row aria-expanded toggles on click", () => {
    seed([broken]);
    const { getAllByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    const rows = getAllByRole("button").filter((el) => el.hasAttribute("aria-expanded"));
    const row = rows[0];
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("cancelling scale popover hides the input", () => {
    seed([broken]);
    const { getByText, queryByRole } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText("ollama")); // expand
    fireEvent.click(getByText("scale")); // open popover
    fireEvent.click(getByText("✕")); // cancel
    expect(queryByRole("spinbutton", { name: /replica count/i })).toBeNull();
    expect(getByText("scale")).toBeTruthy(); // button back
  });

  it("openLiveWorkloads is called on mount (replaces listWorkloads)", () => {
    render(<WorkloadsView cluster="homelab-nelli" />);
    expect(openLiveWorkloads).toHaveBeenCalledWith("homelab-nelli", "");
  });

  it("live=true renders green live indicator", () => {
    seed([broken]);
    useFleet.setState((s) => ({ workloads: { ...s.workloads, live: true } }));
    const { getByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(getByText("live")).toBeTruthy();
  });

  it("live=false renders manual fallback indicator", () => {
    seed([broken]);
    useFleet.setState((s) => ({ workloads: { ...s.workloads, live: false } }));
    const { getByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(getByText("○ manual")).toBeTruthy();
  });

  // --- Aggregate logs dock ---

  it("row terminal icon opens the aggregate-logs dock in workload mode", () => {
    seed([broken]);
    const { getByRole, getByTestId } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByRole("button", { name: /aggregate logs for ollama-prod\/ollama/i }));
    expect(getByTestId("workload-logs-dock")).toBeTruthy();
    expect(getByTestId("logs-pane-stub").textContent).toBe("Deployment:ollama-prod/ollama");
  });

  it("clicking the logs icon does not expand the row", () => {
    seed([broken]);
    const { getByRole, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByRole("button", { name: /aggregate logs for ollama-prod\/ollama/i }));
    expect(queryByText("ollama-x")).toBeNull(); // expanded pod table absent
  });

  it("l key opens the dock for the keyboard-selected row", () => {
    seed([broken, healthy]);
    const { getByTestId } = render(<WorkloadsView cluster="homelab-nelli" />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true })); });
    expect(getByTestId("logs-pane-stub").textContent).toBe("Deployment:ollama-prod/ollama");
  });

  it("✕ closes the dock", () => {
    seed([broken]);
    const { getByRole, queryByTestId } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByRole("button", { name: /aggregate logs for ollama-prod\/ollama/i }));
    expect(queryByTestId("workload-logs-dock")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /close logs dock/i }));
    expect(queryByTestId("workload-logs-dock")).toBeNull();
  });

  it("pop-out calls openWorkloadLogsWindow and closes the dock on success", async () => {
    seed([broken]);
    const { getByRole, queryByTestId, findByTestId } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByRole("button", { name: /aggregate logs for ollama-prod\/ollama/i }));
    await findByTestId("workload-logs-dock");
    fireEvent.click(getByRole("button", { name: /open logs in window/i }));
    expect(openWorkloadLogsWindow).toHaveBeenCalledWith("homelab-nelli", "ollama-prod", "Deployment", "ollama", "");
    await act(async () => {}); // flush the resolved promise
    expect(queryByTestId("workload-logs-dock")).toBeNull();
  });
});
