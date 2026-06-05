import { describe, it, test, expect, beforeEach } from "vitest";
import { useFleet, crdCountKey } from "./fleet";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("fleet store routing", () => {
  it("openCluster enters cluster scope on overview", () => {
    useFleet.getState().openCluster("homelab-nelli");
    expect(useFleet.getState().route).toEqual({ name: "cluster", cluster: "homelab-nelli", section: "overview" });
  });
  it("setSection changes section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("gitops");
    expect(useFleet.getState().route).toEqual({ name: "cluster", cluster: "x", section: "gitops" });
  });
  it("setSection is a no-op at the fleet root", () => {
    useFleet.getState().setSection("gitops");
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("openFleet returns to the grid", () => {
    useFleet.getState().openCluster("x");
    useFleet.getState().openFleet();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("keeps the selected cluster resolvable after setClusters", () => {
    useFleet.getState().openCluster("x");
    useFleet.getState().setClusters([
      { name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v1",
        gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
        env: "", region: "", provider: "", group: "", ageSeconds: 0 },
    ]);
    const st = useFleet.getState();
    expect(st.route).toMatchObject({ name: "cluster", cluster: "x" });
    expect(st.clusters.find((c) => c.name === "x")).toBeTruthy();
  });
});

test("crd slice: set groups, toggle, count, search, groupBy", () => {
  useFleet.getState().setCRDs("x", [
    { group: "cilium.io", category: "CNI", kinds: [{ kind: "CiliumEndpoint", plural: "ciliumendpoints", scope: "Namespaced", version: "v2", operator: "cilium", shortNames: ["cep"] }] },
  ]);
  expect(useFleet.getState().crd.groups.length).toBe(1);

  useFleet.getState().toggleCRDGroup("cilium.io");
  expect(useFleet.getState().crd.expanded).toContain("cilium.io");
  useFleet.getState().toggleCRDGroup("cilium.io");
  expect(useFleet.getState().crd.expanded).not.toContain("cilium.io");

  const key = crdCountKey("cilium.io", "v2", "ciliumendpoints");
  useFleet.getState().setCRDCount(key, { count: 500, capped: true });
  expect(useFleet.getState().crd.counts[key].capped).toBe(true);

  useFleet.getState().setCRDGroupBy("scope");
  expect(useFleet.getState().crd.groupBy).toBe("scope");
  useFleet.getState().setCRDSearch("cep");
  expect(useFleet.getState().crd.search).toBe("cep");
});

it("action status set and clear", () => {
  useFleet.getState().setActionStatus({ kind: "success", message: "Reconcile requested" });
  expect(useFleet.getState().actionStatus?.message).toBe("Reconcile requested");
  useFleet.getState().clearActionStatus();
  expect(useFleet.getState().actionStatus).toBeNull();
});
