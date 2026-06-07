import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MeshStrip } from "./MeshStrip";
import type { MeshGraphDTO } from "../store/fleet";

const graph: MeshGraphDTO = {
  nodes: [
    { cluster: "ctx-blue", name: "homelab-blue", clusterId: 1, state: "peered", present: true },
    { cluster: "ctx-orange", name: "homelab-orange", clusterId: 2, state: "peered", present: true },
    { cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true },
    { cluster: "", name: "aks-prd-we", clusterId: null, state: "peered", present: false },
  ],
  edges: [
    { a: "ctx-blue", b: "ctx-orange", mutual: true },
    { a: "ctx-blue", b: "aks-prd-we", mutual: false },
  ],
};

describe("MeshStrip", () => {
  it("renders nothing when no node is mesh-capable", () => {
    const { container } = render(<MeshStrip graph={{ nodes: [{ cluster: "x", name: "x", clusterId: null, state: "unavailable", present: true }], edges: [] }} />);
    expect(container.textContent).toBe("");
  });

  it("renders the strip with cluster names, the configured-peering caption, and an off-fleet node", () => {
    const { getByText } = render(<MeshStrip graph={graph} />);
    expect(getByText(/CLUSTER-?MESH/i)).toBeTruthy();
    expect(getByText(/configured peering \(not live connectivity\)/i)).toBeTruthy();
    expect(getByText("homelab-blue")).toBeTruthy();
    expect(getByText("aks-prd-we")).toBeTruthy(); // off-fleet node shown
  });

  it("mutes a non-peered cluster (unavailable = no ClusterMesh) with the ⬡ marker", () => {
    const g: MeshGraphDTO = {
      nodes: [
        { cluster: "ctx-blue", name: "homelab-blue", clusterId: 1, state: "peered", present: true },
        { cluster: "ctx-orange", name: "homelab-orange", clusterId: 2, state: "peered", present: true },
        { cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "unavailable", present: true },
      ],
      edges: [{ a: "ctx-blue", b: "ctx-orange", mutual: true }],
    };
    const { getByTitle, getAllByTitle } = render(<MeshStrip graph={g} />);
    // nelli (no ClusterMesh) is muted with the "no ClusterMesh" title and a ⬡ marker.
    const nelli = getByTitle("no ClusterMesh");
    expect(nelli.textContent).toContain("⬡");
    // the two peered clusters are NOT muted (no ⬡).
    const meshed = getAllByTitle("meshed");
    expect(meshed.length).toBe(2);
    expect(meshed[0].textContent).not.toContain("⬡");
  });
});
