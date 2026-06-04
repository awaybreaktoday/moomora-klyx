import { describe, it, expect, beforeEach } from "vitest";
import { useFleet, FluxResourceDTO } from "./fleet";

const r = (over: Partial<FluxResourceDTO>): FluxResourceDTO => ({
  kind: "Kustomization", namespace: "flux-system", name: "flux-system",
  ready: "Ready", message: "", revision: "main@abc", lastAppliedAgeSeconds: 1, suspended: false, ...over,
});

beforeEach(() => useFleet.setState({ gitops: { cluster: null, resources: [], loading: false } }));

describe("gitops store", () => {
  it("setGitOps stores resources for a cluster", () => {
    useFleet.getState().setGitOps("x", [r({ name: "a" })]);
    const g = useFleet.getState().gitops;
    expect(g.cluster).toBe("x");
    expect(g.resources).toHaveLength(1);
    expect(g.loading).toBe(false);
  });
  it("setGitOpsLoading marks loading for a cluster", () => {
    useFleet.getState().setGitOpsLoading("x");
    expect(useFleet.getState().gitops.loading).toBe(true);
    expect(useFleet.getState().gitops.cluster).toBe("x");
  });
  it("clearGitOps resets the slice", () => {
    useFleet.getState().setGitOps("x", [r({})]);
    useFleet.getState().clearGitOps();
    expect(useFleet.getState().gitops).toEqual({ cluster: null, resources: [], loading: false });
  });
});
