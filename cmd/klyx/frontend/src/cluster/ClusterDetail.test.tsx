import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import type { ClusterDTO } from "../store/fleet";
import { ClusterDetail } from "./ClusterDetail";

vi.mock("../bridge/gitops", () => ({
  openGitOps: async () => () => {},
  closeGitOps: async () => {},
}));

const dto = (over: Partial<ClusterDTO>): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v9",
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0, ...over,
});

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("ClusterDetail", () => {
  it("renders Overview for the selected cluster", () => {
    useFleet.setState({ clusters: [dto({ name: "x" })], route: { name: "cluster", cluster: "x", section: "overview" } });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText("v9")).toBeTruthy();
  });
  it("renders the GitOps view for the gitops section", () => {
    useFleet.setState({
      clusters: [dto({ name: "x", gitopsTier: "Healthy" })],
      route: { name: "cluster", cluster: "x", section: "gitops" },
      gitops: { cluster: "x", resources: [], loading: false },
    });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText(/No Flux resources found/i)).toBeTruthy();
  });
  it("shows a notice when the cluster is gone", () => {
    useFleet.setState({ clusters: [], route: { name: "cluster", cluster: "ghost", section: "overview" } });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText(/no longer in the fleet/i)).toBeTruthy();
  });
});
