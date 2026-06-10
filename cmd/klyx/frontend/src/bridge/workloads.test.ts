import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFleet } from "../store/fleet";

// Mock the bindings before importing the bridge.
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  WorkloadsService: {
    RolloutRestart: vi.fn(),
    ScaleWorkload: vi.fn(),
    ListWorkloads: vi.fn().mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] }),
    OpenLiveWorkloads: vi.fn().mockResolvedValue({ ok: true, error: "" }),
    CloseAll: vi.fn().mockResolvedValue(undefined),
    CloseWorkloads: vi.fn().mockResolvedValue(undefined),
    CloseLiveWorkloads: vi.fn().mockResolvedValue(undefined),
  },
}));

const eventHandlers: Record<string, (ev: unknown) => void> = {};
const offFns: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: vi.fn((name: string, handler: (ev: unknown) => void) => {
      eventHandlers[name] = handler;
      const off = vi.fn();
      offFns[name] = off;
      return off;
    }),
  },
}));

import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { Events } from "@wailsio/runtime";
import { rolloutRestart, scaleWorkload, openLiveWorkloads } from "./workloads";

function seedWorkloads(cluster: string, namespace: string) {
  useFleet.setState((s) => ({
    workloads: {
      ...s.workloads, cluster, namespace, items: [], namespaces: [], fluxPresent: false, loading: false,
      kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true },
      needsAttention: false, expanded: [], metricsAvailable: false, metricsStatus: null, metricsStale: false, nearLimitSort: false,
    },
  }));
}

describe("rolloutRestart bridge", () => {
  beforeEach(() => {
    useFleet.getState().clearWorkloads();
    useFleet.getState().clearActionStatus();
    vi.clearAllMocks();
  });

  it("success: sets success actionStatus with correct message (Deployment)", async () => {
    (WorkloadsService.RolloutRestart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (WorkloadsService.ListWorkloads as ReturnType<typeof vi.fn>).mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] });
    seedWorkloads("homelab", "monitoring");

    await rolloutRestart("homelab", "Deployment", "monitoring", "grafana");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("success");
    expect(status?.message).toBe("restart triggered for deployment monitoring/grafana");
  });

  it("success: message lowercases the kind (StatefulSet)", async () => {
    (WorkloadsService.RolloutRestart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (WorkloadsService.ListWorkloads as ReturnType<typeof vi.fn>).mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] });
    seedWorkloads("homelab", "db");

    await rolloutRestart("homelab", "StatefulSet", "db", "postgres");

    expect(useFleet.getState().actionStatus?.message).toBe("restart triggered for statefulset db/postgres");
  });

  it("success: re-runs listWorkloads on the current namespace", async () => {
    (WorkloadsService.RolloutRestart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (WorkloadsService.ListWorkloads as ReturnType<typeof vi.fn>).mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] });
    seedWorkloads("homelab", "monitoring");

    await rolloutRestart("homelab", "Deployment", "monitoring", "grafana");

    expect(WorkloadsService.ListWorkloads).toHaveBeenCalledWith("homelab", "monitoring");
  });

  it("error: sets error actionStatus and does NOT refresh the list", async () => {
    (WorkloadsService.RolloutRestart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "not found" });
    seedWorkloads("homelab", "monitoring");

    await rolloutRestart("homelab", "Deployment", "monitoring", "grafana");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("error");
    expect(status?.message).toBe("not found");
    expect(WorkloadsService.ListWorkloads).not.toHaveBeenCalled();
  });

  it("error: uses fallback message when error field is empty", async () => {
    (WorkloadsService.RolloutRestart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "" });
    seedWorkloads("homelab", "monitoring");

    await rolloutRestart("homelab", "Deployment", "monitoring", "grafana");

    expect(useFleet.getState().actionStatus?.message).toBe("Restart failed");
  });
});

describe("scaleWorkload bridge", () => {
  beforeEach(() => {
    useFleet.getState().clearWorkloads();
    useFleet.getState().clearActionStatus();
    vi.clearAllMocks();
  });

  it("success: sets success actionStatus with kind, ns, name and replica count", async () => {
    (WorkloadsService.ScaleWorkload as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (WorkloadsService.ListWorkloads as ReturnType<typeof vi.fn>).mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] });
    seedWorkloads("homelab", "monitoring");

    await scaleWorkload("homelab", "Deployment", "monitoring", "grafana", 3);

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("success");
    expect(status?.message).toBe("scaled deployment monitoring/grafana to 3");
  });

  it("success: re-runs listWorkloads on the current namespace", async () => {
    (WorkloadsService.ScaleWorkload as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (WorkloadsService.ListWorkloads as ReturnType<typeof vi.fn>).mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] });
    seedWorkloads("homelab", "db");

    await scaleWorkload("homelab", "StatefulSet", "db", "postgres", 0);

    expect(WorkloadsService.ListWorkloads).toHaveBeenCalledWith("homelab", "db");
  });

  it("error: sets error actionStatus and does NOT refresh the list", async () => {
    (WorkloadsService.ScaleWorkload as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "unsupported kind" });
    seedWorkloads("homelab", "kube-system");

    await scaleWorkload("homelab", "DaemonSet", "kube-system", "cilium", 1);

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("error");
    expect(status?.message).toBe("unsupported kind");
    expect(WorkloadsService.ListWorkloads).not.toHaveBeenCalled();
  });

  it("error: uses fallback message when error field is empty", async () => {
    (WorkloadsService.ScaleWorkload as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "" });
    seedWorkloads("homelab", "ns");

    await scaleWorkload("homelab", "Deployment", "ns", "api", 1);

    expect(useFleet.getState().actionStatus?.message).toBe("Scale failed");
  });
});

describe("openLiveWorkloads bridge", () => {
  beforeEach(() => {
    useFleet.getState().clearWorkloads();
    vi.clearAllMocks();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    for (const k of Object.keys(offFns)) delete offFns[k];
  });

  it("subscribes to data and status events and calls OpenLiveWorkloads", () => {
    seedWorkloads("homelab", "");
    openLiveWorkloads("homelab", "");

    expect(Events.On).toHaveBeenCalledWith("liveWorkloads:homelab:", expect.any(Function));
    expect(Events.On).toHaveBeenCalledWith("liveWorkloadsStatus:homelab:", expect.any(Function));
    expect(WorkloadsService.OpenLiveWorkloads).toHaveBeenCalledWith("homelab", "");
  });

  it("data event payload updates the workloads store", () => {
    seedWorkloads("homelab", "");
    openLiveWorkloads("homelab", "");

    const handler = eventHandlers["liveWorkloads:homelab:"];
    expect(handler).toBeDefined();
    handler({ data: { fluxPresent: true, namespaces: ["monitoring"], workloads: [] } });

    expect(useFleet.getState().workloads.namespaces).toEqual(["monitoring"]);
    expect(useFleet.getState().workloads.fluxPresent).toBe(true);
  });

  it("status event sets live flag in store", () => {
    seedWorkloads("homelab", "");
    openLiveWorkloads("homelab", "");

    const statusHandler = eventHandlers["liveWorkloadsStatus:homelab:"];
    expect(statusHandler).toBeDefined();
    statusHandler({ data: { live: true } });

    expect(useFleet.getState().workloads.live).toBe(true);
  });

  it("cleanup unsubscribes both events and calls CloseLiveWorkloads", () => {
    seedWorkloads("homelab", "");
    const cleanup = openLiveWorkloads("homelab", "");

    cleanup();

    expect(offFns["liveWorkloads:homelab:"]!).toHaveBeenCalled();
    expect(offFns["liveWorkloadsStatus:homelab:"]!).toHaveBeenCalled();
    expect(WorkloadsService.CloseLiveWorkloads).toHaveBeenCalledWith("homelab", "");
  });

  it("stale-guard: emit from a replaced sub (old namespace) is dropped", () => {
    // Open kube-system, then switch to monitoring: the new open claims the
    // slice. A late emit from the old namespace's handler must be dropped.
    openLiveWorkloads("homelab", "kube-system");
    const oldHandler = eventHandlers["liveWorkloads:homelab:kube-system"];
    openLiveWorkloads("homelab", "monitoring");

    oldHandler({ data: { fluxPresent: false, namespaces: ["kube-system"], workloads: [] } });

    expect(useFleet.getState().workloads.namespace).toBe("monitoring");
    expect(useFleet.getState().workloads.items).toHaveLength(0);
  });
});
