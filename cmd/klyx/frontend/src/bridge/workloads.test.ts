import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFleet } from "../store/fleet";

// Mock the bindings before importing the bridge.
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  WorkloadsService: {
    RolloutRestart: vi.fn(),
    ScaleWorkload: vi.fn(),
    ListWorkloads: vi.fn().mockResolvedValue({ fluxPresent: false, namespaces: [], workloads: [] }),
  },
}));

import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { rolloutRestart, scaleWorkload } from "./workloads";

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
