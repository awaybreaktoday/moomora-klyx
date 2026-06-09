import { describe, it, expect } from "vitest";
import { saturation, nearLimitSort, fmtCpu, fmtMem } from "./saturation";
import type { WorkloadDTO } from "../store/fleet";

const Mi = 1048576;

describe("saturation", () => {
  it("memory tiers: 90% danger, 75% warn, below neutral", () => {
    expect(saturation("mem", 470, 512).tier).toBe("danger");
    expect(saturation("mem", 400, 512).tier).toBe("warn");
    expect(saturation("mem", 200, 512).tier).toBe("neutral");
  });
  it("cpu tiers: 100% danger, 90% warn, below neutral", () => {
    expect(saturation("cpu", 0.55, 0.5).tier).toBe("danger");
    expect(saturation("cpu", 0.46, 0.5).tier).toBe("warn");
    expect(saturation("cpu", 0.2, 0.5).tier).toBe("neutral");
  });
  it("no calculable saturation when usage or limit absent", () => {
    expect(saturation("mem", null, 512)).toEqual({ pct: null, tier: "none" });
    expect(saturation("mem", 470, null)).toEqual({ pct: null, tier: "none" });
    expect(saturation("cpu", 0.5, 0)).toEqual({ pct: null, tier: "none" });
  });
});

const wl = (name: string, memUsage: number | null, memLimit: number | null, rank: WorkloadDTO["rank"] = "healthy"): WorkloadDTO => ({
  kind: "Deployment", namespace: "ns", name, desired: 1, ready: 1, available: 1, updated: 1,
  restarts: 0, reason: "", rank, gitops: null, pods: [],
  resources: { cpu: { usage: null, request: null, limit: null }, mem: { usage: memUsage, request: null, limit: memLimit } },
});

describe("nearLimitSort", () => {
  it("orders by mem saturation desc; no-calc rows sink below", () => {
    const rows = [wl("low", 100 * Mi, 1000 * Mi), wl("nolimit", 900 * Mi, null), wl("high", 950 * Mi, 1000 * Mi)];
    const out = nearLimitSort(rows).map((r) => r.name);
    expect(out).toEqual(["high", "low", "nolimit"]);
  });
  it("ties (both no-calc) fall back to k8s rank then name", () => {
    const a = wl("b-name", null, null, "healthy");
    const b = wl("a-name", null, null, "unhealthy");
    const out = nearLimitSort([a, b]).map((r) => r.name);
    expect(out).toEqual(["a-name", "b-name"]);
  });
});

describe("formatting", () => {
  it("cpu millicores below 1 core, cores above", () => {
    expect(fmtCpu(0.18)).toBe("180m");
    expect(fmtCpu(1.1)).toBe("1.10");
  });
  it("mem Mi below 1Gi, Gi above", () => {
    expect(fmtMem(470 * Mi)).toBe("470Mi");
    expect(fmtMem(2 * 1024 * Mi)).toBe("2.0Gi");
  });
});
