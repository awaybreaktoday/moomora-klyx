import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFleet } from "../store/fleet";

// Mock the bindings before importing the bridge.
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  PodsService: {
    DeletePod: vi.fn(),
    ListPods: vi.fn().mockResolvedValue({ namespaces: [], pods: [] }),
    GetPodDetail: vi.fn(),
  },
}));

import { PodsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { deletePod } from "./pods";

// Seed the store so we can verify list refresh.
function seedPods(cluster: string, namespace: string) {
  useFleet.setState((s) => ({
    pods: { ...s.pods, cluster, namespace, items: [], namespaces: [], loading: false, needsAttention: false, search: "", selected: null, detail: null, detailLoading: false },
  }));
}

describe("deletePod bridge", () => {
  beforeEach(() => {
    useFleet.getState().clearPods();
    useFleet.getState().clearActionStatus();
    vi.clearAllMocks();
  });

  it("success: sets success actionStatus with correct message", async () => {
    (PodsService.DeletePod as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (PodsService.ListPods as ReturnType<typeof vi.fn>).mockResolvedValue({ namespaces: [], pods: [] });
    seedPods("homelab", "default");

    await deletePod("homelab", "default", "api-xyz");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("success");
    expect(status?.message).toBe("pod default/api-xyz deleted");
  });

  it("success: re-runs listPods on the current namespace", async () => {
    (PodsService.DeletePod as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });
    (PodsService.ListPods as ReturnType<typeof vi.fn>).mockResolvedValue({ namespaces: [], pods: [] });
    seedPods("homelab", "monitoring");

    await deletePod("homelab", "monitoring", "grafana-abc");

    expect(PodsService.ListPods).toHaveBeenCalledWith("homelab", "monitoring");
  });

  it("error: sets error actionStatus and does NOT refresh the list", async () => {
    (PodsService.DeletePod as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "forbidden" });
    seedPods("homelab", "default");

    await deletePod("homelab", "default", "api-xyz");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("error");
    expect(status?.message).toBe("forbidden");
    // ListPods should NOT be called on failure.
    expect(PodsService.ListPods).not.toHaveBeenCalled();
  });

  it("error: uses fallback message when error field is empty", async () => {
    (PodsService.DeletePod as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "" });
    seedPods("homelab", "default");

    await deletePod("homelab", "default", "api-xyz");

    expect(useFleet.getState().actionStatus?.message).toBe("Delete failed");
  });
});
