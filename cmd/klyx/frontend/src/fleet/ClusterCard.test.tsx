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
});

it("drills into the cluster on click", () => {
  useFleet.setState({ route: { name: "fleet" } });
  const { getByText } = render(<ClusterCard c={base} />);
  getByText("plt-sea-prd-we-aks-01").click();
  expect(useFleet.getState().route).toMatchObject({ name: "cluster", cluster: "plt-sea-prd-we-aks-01" });
});
