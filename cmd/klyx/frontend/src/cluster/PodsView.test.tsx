import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PodsView } from "./PodsView";
import { useFleet } from "../store/fleet";
import type { PodSummaryDTO, PodDetailDTO } from "../store/fleet";

vi.mock("../bridge/pods", () => ({
  listPods: vi.fn().mockResolvedValue(undefined),
  openPodDetail: vi.fn().mockResolvedValue(undefined),
}));
import { openPodDetail } from "../bridge/pods";

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
});
