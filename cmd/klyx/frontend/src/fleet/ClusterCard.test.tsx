import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ClusterCard } from "./ClusterCard";
import type { ClusterDTO } from "../store/fleet";
import { useFleet } from "../store/fleet";

const base: ClusterDTO = {
  name: "plt-sea-prd-we-aks-01", state: "Synced", reason: "",
  nodesReady: 12, nodesTotal: 12, pods: 487, version: "v1.30.4",
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "prd", region: "we", provider: "aks", group: "prd-we", ageSeconds: 15,
};

describe("ClusterCard", () => {
  it("renders name, version and counts", () => {
    const { getByText } = render(<ClusterCard c={base} />);
    expect(getByText("plt-sea-prd-we-aks-01")).toBeTruthy();
    expect(getByText("v1.30.4")).toBeTruthy();
    expect(getByText("12/12")).toBeTruthy();
    expect(getByText("487")).toBeTruthy();
  });

  it("shows the reason for a failed cluster", () => {
    const { getByText } = render(
      <ClusterCard c={{ ...base, state: "Failed", reason: "connect timed out" }} />,
    );
    expect(getByText(/connect timed out/i)).toBeTruthy();
  });

  it("shows a lock affordance for a protected cluster", () => {
    const { queryByTitle } = render(<ClusterCard c={{ ...base, protected: true }} />);
    expect(queryByTitle("protected")).toBeTruthy();
  });

  it("has no lock for an unprotected cluster", () => {
    const { queryByTitle } = render(<ClusterCard c={{ ...base, protected: false }} />);
    expect(queryByTitle("protected")).toBeNull();
  });
});

it("drills into the cluster on click", () => {
  useFleet.setState({ route: { name: "fleet" } });
  const { getByText } = render(<ClusterCard c={base} />);
  getByText("plt-sea-prd-we-aks-01").click();
  expect(useFleet.getState().route).toMatchObject({ name: "cluster", cluster: "plt-sea-prd-we-aks-01" });
});

it("shows the mesh row from the graph: peered / asymmetric / standalone / off-fleet", () => {
  useFleet.setState({ mesh: {
    nodes: [
      { cluster: "ctx-blue", name: "homelab-blue", clusterId: 1, state: "peered", present: true },
      { cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true },
    ],
    edges: [{ a: "ctx-blue", b: "ctx-orange", mutual: true }],
  }});
  // a peered cluster shows its peer
  const blue = { name: "ctx-blue", state: "Ready", networkTier: "Healthy" } as any;
  const { getByText } = render(<ClusterCard c={blue} />);
  expect(getByText(/mesh:/i)).toBeTruthy();
  expect(getByText(/ctx-orange/)).toBeTruthy();
});

it("shows 'mesh enabled, no peers' for an installed-but-peerless cluster", () => {
  useFleet.setState({ mesh: {
    nodes: [{ cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true }],
    edges: [],
  }});
  const nelli = { name: "ctx-nelli", state: "Ready", networkTier: "Healthy" } as any;
  const { getByText } = render(<ClusterCard c={nelli} />);
  expect(getByText(/mesh enabled, no peers/i)).toBeTruthy();
});
