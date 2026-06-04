import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Placeholder } from "./Placeholder";
import type { ClusterDTO } from "../store/fleet";

const dto = (over: Partial<ClusterDTO>): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v1",
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0, ...over,
});

describe("Placeholder", () => {
  it("gitops Absent says no Flux/Argo", () => {
    const { getByText } = render(<Placeholder section="gitops" c={dto({ gitopsTier: "Absent" })} />);
    expect(getByText(/No Flux or Argo/i)).toBeTruthy();
  });
  it("gitops present says arrives in M3", () => {
    const { getByText } = render(<Placeholder section="gitops" c={dto({ gitopsTier: "Healthy" })} />);
    expect(getByText(/arrives in M3/i)).toBeTruthy();
  });
  it("resources says CRD browser arrives in M4", () => {
    const { getByText } = render(<Placeholder section="resources" c={dto({})} />);
    expect(getByText(/CRD browser arrives in M4/i)).toBeTruthy();
  });
});
