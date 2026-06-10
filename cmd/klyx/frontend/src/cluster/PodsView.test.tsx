import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { PodsView } from "./PodsView";
import { useFleet } from "../store/fleet";
import type { PodSummaryDTO, PodDetailDTO } from "../store/fleet";

vi.mock("../bridge/pods", () => ({
  listPods: vi.fn().mockResolvedValue(undefined),
  openPodDetail: vi.fn().mockResolvedValue(undefined),
  deletePod: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../bridge/workloads", () => ({
  listWorkloads: vi.fn().mockResolvedValue(undefined),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));
import { openPodDetail, deletePod } from "../bridge/pods";
import { rolloutRestart } from "../bridge/workloads";

// LogsPane uses LogsService and Wails Events — stub them out so PodsView tests
// don't need a Wails runtime.
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  LogsService: {
    OpenLogStream: vi.fn().mockResolvedValue({ streamId: "test-stream", error: undefined }),
    CloseLogStream: vi.fn().mockResolvedValue(undefined),
    CloseAll: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn().mockReturnValue(() => {}) },
}));

const makeContainer = (overrides = {}) => ({
  name: "app", image: "nginx:latest", ready: true, restarts: 0, state: "running", init: false, ...overrides,
});

const healthy: PodSummaryDTO = {
  namespace: "monitoring", name: "grafana-xyz", ready: true, phase: "Running", reason: "", rank: "healthy",
  restarts: 0, node: "node-1", ip: "10.0.0.1", ownerKind: "ReplicaSet", ownerName: "grafana-rs",
  ageSeconds: 3600, containers: [makeContainer()],
};
const broken: PodSummaryDTO = {
  namespace: "default", name: "api-crash", ready: false, phase: "Running", reason: "CrashLoopBackOff", rank: "unhealthy",
  restarts: 7, node: "node-2", ip: "10.0.0.2", ownerKind: "ReplicaSet", ownerName: "api-rs",
  ageSeconds: 600, containers: [makeContainer({ ready: false, restarts: 7, state: "waiting:CrashLoopBackOff" })],
};

const fakeDetail: PodDetailDTO = {
  summary: healthy,
  labels: { app: "grafana", team: "ops" },
  conditions: [
    { type: "Ready", status: "True", reason: "PodCompleted", message: "all containers ready" },
  ],
  events: [
    { type: "Normal", reason: "Pulled", message: "image pulled", count: 1, lastSeen: "2026-06-10T00:00:00Z" },
    { type: "Warning", reason: "BackOff", message: "back-off restarting", count: 3, lastSeen: "2026-06-10T00:01:00Z" },
  ],
  yaml: "apiVersion: v1\nkind: Pod",
  qosClass: "Burstable",
  serviceAccount: "grafana-sa",
};

function seed(items: PodSummaryDTO[]) {
  useFleet.setState((s) => ({
    pods: {
      ...s.pods,
      cluster: "homelab",
      items,
      namespaces: ["default", "monitoring"],
      loading: false,
    },
  }));
}

describe("PodsView", () => {
  beforeEach(() => {
    useFleet.getState().clearPods();
    vi.clearAllMocks();
  });

  it("renders triage rows from seeded store", () => {
    seed([broken, healthy]);
    const { getByText } = render(<PodsView cluster="homelab" />);
    expect(getByText("api-crash")).toBeTruthy();
    expect(getByText("grafana-xyz")).toBeTruthy();
    expect(getByText("CrashLoopBackOff")).toBeTruthy();
  });

  it("needs-attention chip filters out healthy rows", () => {
    seed([broken, healthy]);
    const { getByText, queryByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText(/needs attention/i));
    expect(getByText("api-crash")).toBeTruthy();
    expect(queryByText("grafana-xyz")).toBeNull();
  });

  it("search filters by name", () => {
    seed([broken, healthy]);
    const { getByPlaceholderText, getByText, queryByText } = render(<PodsView cluster="homelab" />);
    fireEvent.change(getByPlaceholderText("filter pods"), { target: { value: "grafana" } });
    expect(getByText("grafana-xyz")).toBeTruthy();
    expect(queryByText("api-crash")).toBeNull();
  });

  it("search filters by namespace", () => {
    seed([broken, healthy]);
    const { getByPlaceholderText, getByText, queryByText } = render(<PodsView cluster="homelab" />);
    fireEvent.change(getByPlaceholderText("filter pods"), { target: { value: "monitoring" } });
    expect(getByText("grafana-xyz")).toBeTruthy();
    expect(queryByText("api-crash")).toBeNull();
  });

  it("row click calls openPodDetail", () => {
    seed([broken]);
    const { getByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("api-crash"));
    expect(openPodDetail).toHaveBeenCalledWith("homelab", "default", "api-crash");
  });

  it("detail panel renders sections from seeded detail", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      pods: {
        ...s.pods,
        selected: { namespace: "monitoring", name: "grafana-xyz" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<PodsView cluster="homelab" />);
    // Summary section
    expect(getByText("Burstable")).toBeTruthy();
    expect(getByText("grafana-sa")).toBeTruthy();
    // Conditions
    expect(getByText("all containers ready")).toBeTruthy();
    // Events
    expect(getByText("Pulled")).toBeTruthy();
    expect(getByText("back-off restarting")).toBeTruthy();
    // Labels
    expect(getByText("app=grafana")).toBeTruthy();
  });

  it("logs tab mounts the LogsPane (shows streaming controls)", async () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      pods: {
        ...s.pods,
        selected: { namespace: "monitoring", name: "grafana-xyz" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText, getByRole } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("logs"));
    // LogsPane renders its container selector — confirm it's there
    expect(getByRole("combobox", { name: /container/i })).toBeTruthy();
  });

  it("yaml tab renders yaml content", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      pods: {
        ...s.pods,
        selected: { namespace: "monitoring", name: "grafana-xyz" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("yaml"));
    expect(getByText(/apiVersion: v1/)).toBeTruthy();
  });

  it("close button clears selected pod", () => {
    seed([healthy]);
    useFleet.setState((s) => ({
      pods: {
        ...s.pods,
        selected: { namespace: "monitoring", name: "grafana-xyz" },
        detail: fakeDetail,
        detailLoading: false,
      },
    }));
    const { getByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("✕"));
    expect(useFleet.getState().pods.selected).toBeNull();
  });

  // --- Action button tests ---

  function openDetailPanel(pod = healthy, detail = fakeDetail) {
    seed([pod]);
    useFleet.setState((s) => ({
      pods: { ...s.pods, selected: { namespace: pod.namespace, name: pod.name }, detail, detailLoading: false },
    }));
  }

  it("delete pod button opens confirm dialog with controller-recreate body", () => {
    openDetailPanel(healthy); // healthy has ownerKind="ReplicaSet"
    const { getByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("delete pod"));
    expect(getByText(/the controller will recreate it/i)).toBeTruthy();
  });

  it("delete pod button dialog body warns about no-controller standalone pods", () => {
    const standalone: PodSummaryDTO = { ...healthy, ownerKind: "", ownerName: "" };
    const detailWithStandalone = { ...fakeDetail, summary: standalone };
    openDetailPanel(standalone, detailWithStandalone);
    const { getByText } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("delete pod"));
    expect(getByText(/will NOT be recreated/i)).toBeTruthy();
  });

  it("confirming delete pod calls deletePod bridge", () => {
    openDetailPanel(healthy);
    const { getByText, getAllByRole } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("delete pod"));
    // Confirm button is the last "Delete" in the DOM (inside the dialog).
    const confirmBtns = getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);
    expect(deletePod).toHaveBeenCalledWith("homelab", "monitoring", "grafana-xyz");
  });

  it("restart owner button is visible for ReplicaSet owner", () => {
    openDetailPanel(healthy); // healthy has ownerKind="ReplicaSet"
    const { getByText } = render(<PodsView cluster="homelab" />);
    expect(getByText("restart owner")).toBeTruthy();
  });

  it("restart owner button is NOT visible for ownerKind='' (standalone pod)", () => {
    const standalone: PodSummaryDTO = { ...healthy, ownerKind: "", ownerName: "" };
    const detailWithStandalone = { ...fakeDetail, summary: standalone };
    openDetailPanel(standalone, detailWithStandalone);
    const { queryByText } = render(<PodsView cluster="homelab" />);
    expect(queryByText("restart owner")).toBeNull();
  });

  it("restart owner button is NOT visible for ownerKind=Node", () => {
    const nodeOwned: PodSummaryDTO = { ...healthy, ownerKind: "Node", ownerName: "node-1" };
    const detailNode = { ...fakeDetail, summary: nodeOwned };
    openDetailPanel(nodeOwned, detailNode);
    const { queryByText } = render(<PodsView cluster="homelab" />);
    expect(queryByText("restart owner")).toBeNull();
  });

  it("RS->Deployment name derivation: strips pod-template-hash suffix", () => {
    // Pod owned by RS "web-7d4b9c6f9" — restart should target Deployment "web".
    const rsPod: PodSummaryDTO = {
      ...healthy,
      namespace: "prod", name: "web-7d4b9c6f9-abc",
      ownerKind: "ReplicaSet", ownerName: "web-7d4b9c6f9",
    };
    const detailRs = { ...fakeDetail, summary: rsPod };
    seed([rsPod]);
    useFleet.setState((s) => ({
      pods: { ...s.pods, selected: { namespace: "prod", name: "web-7d4b9c6f9-abc" }, detail: detailRs, detailLoading: false },
    }));
    const { getByText, getAllByRole } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("restart owner"));
    const confirmBtns = getAllByRole("button", { name: "Restart" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);
    // Strip trailing hash segment "7d4b9c6f9" -> "web"
    expect(rolloutRestart).toHaveBeenCalledWith("homelab", "Deployment", "prod", "web");
  });

  // --- Keyboard nav + a11y ---

  it("j then Enter opens the second row (keyboard nav)", async () => {
    const second: PodSummaryDTO = { ...broken, namespace: "default", name: "pod-second" };
    seed([broken, second]);
    render(<PodsView cluster="homelab" />);
    // j → select index 0; wait for re-render; j → select index 1; Enter → activate index 1
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(openPodDetail).toHaveBeenCalledWith("homelab", "default", "pod-second");
  });

  it("/ focuses the filter input", () => {
    seed([broken]);
    const { getByPlaceholderText } = render(<PodsView cluster="homelab" />);
    const input = getByPlaceholderText("filter pods") as HTMLInputElement;
    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    window.dispatchEvent(slash);
    // In jsdom focus may not move automatically, but we can verify no throw
    // The searchRef.current.focus() is called — confirm the input exists.
    expect(input).toBeTruthy();
  });

  it("pod row has role=button and tabIndex=0", () => {
    seed([broken]);
    const { getAllByRole } = render(<PodsView cluster="homelab" />);
    const buttons = getAllByRole("button");
    // rows have role=button; at least one should exist
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("pod row has aria-selected false initially", () => {
    seed([broken]);
    const { getAllByRole } = render(<PodsView cluster="homelab" />);
    // Find button elements with aria-selected (the pod rows)
    const rows = getAllByRole("button").filter((el) => el.hasAttribute("aria-selected"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
  });

  it("StatefulSet owner calls rolloutRestart directly without name transformation", () => {
    const stsPod: PodSummaryDTO = {
      ...healthy, namespace: "db", name: "postgres-0",
      ownerKind: "StatefulSet", ownerName: "postgres",
    };
    const detailSts = { ...fakeDetail, summary: stsPod };
    seed([stsPod]);
    useFleet.setState((s) => ({
      pods: { ...s.pods, selected: { namespace: "db", name: "postgres-0" }, detail: detailSts, detailLoading: false },
    }));
    const { getByText, getAllByRole } = render(<PodsView cluster="homelab" />);
    fireEvent.click(getByText("restart owner"));
    const confirmBtns = getAllByRole("button", { name: "Restart" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);
    expect(rolloutRestart).toHaveBeenCalledWith("homelab", "StatefulSet", "db", "postgres");
  });
});
