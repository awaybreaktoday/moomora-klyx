import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleet";
import type { WorkloadsResultDTO } from "./fleet";

const all: WorkloadsResultDTO = { fluxPresent: true, namespaces: ["a", "b"], workloads: [] };

describe("workloads slice", () => {
  beforeEach(() => useFleet.getState().clearWorkloads());

  it("populates namespaces on all-load and preserves them on a scoped load", () => {
    useFleet.getState().setWorkloads("c", "", all);
    expect(useFleet.getState().workloads.namespaces).toEqual(["a", "b"]);
    // scoped load (namespace != "") must NOT replace the namespace list
    useFleet.getState().setWorkloads("c", "b", { fluxPresent: true, namespaces: [], workloads: [] });
    expect(useFleet.getState().workloads.namespaces).toEqual(["a", "b"]);
  });

  it("falls back to [namespace] when first load is scoped", () => {
    useFleet.getState().setWorkloads("c", "team", { fluxPresent: false, namespaces: [], workloads: [] });
    expect(useFleet.getState().workloads.namespaces).toEqual(["team"]);
  });

  it("toggles expand by key", () => {
    useFleet.getState().toggleWorkloadExpand("Deployment/x/y");
    expect(useFleet.getState().workloads.expanded).toContain("Deployment/x/y");
    useFleet.getState().toggleWorkloadExpand("Deployment/x/y");
    expect(useFleet.getState().workloads.expanded).not.toContain("Deployment/x/y");
  });

  it("clearWorkloads resets kindFilter, needsAttention, and live", () => {
    useFleet.getState().toggleWorkloadKind("Deployment");
    useFleet.getState().toggleNeedsAttention();
    useFleet.getState().setWorkloadsSearch("api");
    expect(useFleet.getState().workloads.kindFilter.Deployment).toBe(false);
    // Manually set live to true.
    useFleet.setState((s) => ({ workloads: { ...s.workloads, live: true } }));
    useFleet.getState().clearWorkloads();
    expect(useFleet.getState().workloads.kindFilter.Deployment).toBe(true);
    expect(useFleet.getState().workloads.needsAttention).toBe(false);
    expect(useFleet.getState().workloads.search).toBe("");
    expect(useFleet.getState().workloads.live).toBe(false);
  });

  it("setWorkloadsSearch stores the search string", () => {
    useFleet.getState().setWorkloadsSearch("grafana");
    expect(useFleet.getState().workloads.search).toBe("grafana");
  });

  it("setWorkloadsLive updates live when cluster+namespace match", () => {
    useFleet.getState().setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [] });
    useFleet.getState().setWorkloadsLive("c", "", true);
    expect(useFleet.getState().workloads.live).toBe(true);
    useFleet.getState().setWorkloadsLive("c", "", false);
    expect(useFleet.getState().workloads.live).toBe(false);
  });

  it("setWorkloadsLive stale-guard: wrong cluster is a no-op", () => {
    useFleet.getState().setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [] });
    useFleet.getState().setWorkloadsLive("other", "", true);
    expect(useFleet.getState().workloads.live).toBe(false);
  });

  it("setWorkloadsLive stale-guard: wrong namespace is a no-op", () => {
    useFleet.getState().setWorkloads("c", "monitoring", { fluxPresent: false, namespaces: ["monitoring"], workloads: [] });
    useFleet.getState().setWorkloadsLive("c", "kube-system", true);
    expect(useFleet.getState().workloads.live).toBe(false);
  });

  it("setWorkloadUsage patches usage by key without replacing rows", () => {
    const f = useFleet.getState();
    f.setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [
      { kind: "Deployment", namespace: "ns", name: "api", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "Available", rank: "healthy", gitops: null, pods: [],
        resources: { cpu: { usage: null, request: 0.25, limit: 0.5 }, mem: { usage: null, request: null, limit: 536870912 } } },
    ] });
    f.setWorkloadUsage("c", "", { status: { available: true, message: "", updatedAt: "t1" }, usage: { "Deployment/ns/api": { cpuUsage: 0.3, memUsage: 400000000 } } });
    const w = useFleet.getState().workloads.items[0];
    expect(w.resources.cpu.usage).toBe(0.3);
    expect(w.resources.cpu.limit).toBe(0.5);
    expect(w.reason).toBe("Available");
    expect(useFleet.getState().workloads.metricsAvailable).toBe(true);
  });

  it("setWorkloadUsage transient failure keeps last-good usage, marks stale", () => {
    const f = useFleet.getState();
    f.setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [
      { kind: "Deployment", namespace: "ns", name: "api", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "", rank: "healthy", gitops: null, pods: [],
        resources: { cpu: { usage: null, request: null, limit: 0.5 }, mem: { usage: null, request: null, limit: null } } },
    ] });
    f.setWorkloadUsage("c", "", { status: { available: true, message: "", updatedAt: "t1" }, usage: { "Deployment/ns/api": { cpuUsage: 0.3, memUsage: null } } });
    f.setWorkloadUsage("c", "", { status: { available: false, message: "down", updatedAt: "" }, usage: {} });
    const s = useFleet.getState().workloads;
    expect(s.items[0].resources.cpu.usage).toBe(0.3);
    expect(s.metricsStale).toBe(true);
  });

  it("setWorkloadUsage first-load unavailable keeps metricsAvailable false (columns hidden)", () => {
    const f = useFleet.getState();
    f.setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [
      { kind: "Deployment", namespace: "ns", name: "api", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "", rank: "healthy", gitops: null, pods: [],
        resources: { cpu: { usage: null, request: null, limit: null }, mem: { usage: null, request: null, limit: null } } },
    ] });
    // No prior available response → an unavailable response must NOT reveal columns.
    f.setWorkloadUsage("c", "", { status: { available: false, message: "no source", updatedAt: "" }, usage: {} });
    const s = useFleet.getState().workloads;
    expect(s.metricsAvailable).toBe(false);
    expect(s.metricsStale).toBe(false);
  });
});
