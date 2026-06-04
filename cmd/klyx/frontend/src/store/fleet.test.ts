import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleet";

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
