import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useFleet, FluxResourceDTO, ClusterDTO } from "../store/fleet";
import { GitOps } from "./GitOps";

vi.mock("../bridge/gitops", () => ({
  openGitOps: async () => () => {},
  closeGitOps: async () => {},
  getResourceDetail: async () => {},
}));

const cluster = (tier: string): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v1",
  gitopsTier: tier, gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0,
});
const res = (over: Partial<FluxResourceDTO>): FluxResourceDTO => ({
  kind: "Kustomization", namespace: "flux-system", name: "flux-system", ready: "Ready",
  message: "", revision: "main@abc", lastAppliedAgeSeconds: 1, suspended: false,
  sourceKind: "", sourceName: "", ...over,
});

beforeEach(() => useFleet.setState({
  clusters: [cluster("Healthy")],
  gitops: { cluster: "x", resources: [], loading: false, expandedKey: null, detail: null },
}));

describe("GitOps view", () => {
  it("renders the resource table from the store", () => {
    useFleet.setState({ gitops: { cluster: "x", resources: [
      res({ name: "flux-system", ready: "Ready" }),
      res({ kind: "HelmRelease", name: "cilium", ready: "Failed", message: "install failed" }),
    ], loading: false, expandedKey: null, detail: null } });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText("flux-system/flux-system")).toBeTruthy();
    expect(getByText("flux-system/cilium")).toBeTruthy();
    expect(getByText(/install failed/i)).toBeTruthy();
  });

  it("shows the no-Flux empty state when gitopsTier is Absent", () => {
    useFleet.setState({ clusters: [cluster("Absent")] });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText(/No Flux or Argo/i)).toBeTruthy();
  });

  it("expands a row and renders its detail from the store", () => {
    useFleet.setState({
      clusters: [cluster("Healthy")],
      gitops: {
        cluster: "x",
        resources: [res({ kind: "Kustomization", namespace: "flux-system", name: "flux-system" })],
        loading: false,
        expandedKey: "Kustomization/flux-system/flux-system",
        detail: {
          kind: "Kustomization", namespace: "flux-system", name: "flux-system",
          appliedRevision: "main@a", attemptedRevision: "main@a", applyFailed: false,
          conditions: [
            { type: "Ready", status: "True", reason: "ok", message: "Applied revision main@a" },
            { type: "Healthy", status: "True", reason: "Succeeded", message: "Health check passed" },
          ],
          inventory: [{ group: "", version: "v1", kind: "ConfigMap", namespace: "monitoring", name: "my-cm" }],
        },
      },
    });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText(/Health check passed/i)).toBeTruthy();
    expect(getByText("ConfigMap · monitoring/my-cm")).toBeTruthy();
  });

  it("shows an apply-failed line when applyFailed", () => {
    useFleet.setState({
      clusters: [cluster("Healthy")],
      gitops: {
        cluster: "x",
        resources: [res({ kind: "Kustomization", namespace: "flux-system", name: "x" })],
        loading: false,
        expandedKey: "Kustomization/flux-system/x",
        detail: {
          kind: "Kustomization", namespace: "flux-system", name: "x",
          appliedRevision: "main@a", attemptedRevision: "main@b", applyFailed: true,
          conditions: [], inventory: [],
        },
      },
    });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText(/apply failed at/i)).toBeTruthy();
  });
});
