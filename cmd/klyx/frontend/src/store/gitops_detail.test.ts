import { describe, it, expect, beforeEach } from "vitest";
import { useFleet, ResourceDetailDTO } from "./fleet";

const detail: ResourceDetailDTO = {
  kind: "Kustomization", namespace: "flux-system", name: "flux-system",
  appliedRevision: "main@a", attemptedRevision: "main@a", applyFailed: false,
  conditions: [{ type: "Ready", status: "True", reason: "ok", message: "applied" }],
  inventory: [{ group: "", version: "v1", kind: "ConfigMap", namespace: "ns", name: "cm" }],
};

beforeEach(() => useFleet.setState({ gitops: { cluster: null, resources: [], sources: [], loading: false, expandedKey: null, detail: null } }));

describe("gitops detail store", () => {
  it("expand sets the key and collapse clears", () => {
    useFleet.getState().expand("Kustomization/flux-system/flux-system");
    expect(useFleet.getState().gitops.expandedKey).toBe("Kustomization/flux-system/flux-system");
    useFleet.getState().collapse();
    expect(useFleet.getState().gitops.expandedKey).toBeNull();
    expect(useFleet.getState().gitops.detail).toBeNull();
  });
  it("setDetail stores the detail", () => {
    useFleet.getState().setDetail(detail);
    expect(useFleet.getState().gitops.detail?.name).toBe("flux-system");
  });
});
