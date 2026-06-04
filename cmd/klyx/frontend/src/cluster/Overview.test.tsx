import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Overview } from "./Overview";
import type { ClusterDTO } from "../store/fleet";

const dto: ClusterDTO = {
  name: "homelab-nelli", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 58,
  version: "v1.36.1", gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "homelab", region: "", provider: "k3s", group: "", ageSeconds: 3,
};

describe("Overview", () => {
  it("renders summary fields from the DTO", () => {
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("homelab-nelli")).toBeTruthy();
    expect(getByText("v1.36.1")).toBeTruthy();
    expect(getByText("1/1")).toBeTruthy();
    expect(getByText("58")).toBeTruthy();
    expect(getByText("homelab")).toBeTruthy();
  });
  it("shows the reason for a failed cluster", () => {
    const { getByText } = render(<Overview c={{ ...dto, state: "Failed", reason: "connect timed out" }} />);
    expect(getByText(/connect timed out/i)).toBeTruthy();
  });
});
