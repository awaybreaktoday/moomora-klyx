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
});
