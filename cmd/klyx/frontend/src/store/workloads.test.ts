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
});
