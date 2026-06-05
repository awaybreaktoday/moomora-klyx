import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Breadcrumb } from "./Breadcrumb";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("Breadcrumb", () => {
  it("shows Fleet at the root", () => {
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("Fleet")).toBeTruthy();
  });
  it("shows Fleet / cluster / Section and Fleet navigates back", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "homelab-nelli", section: "gitops" } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("homelab-nelli")).toBeTruthy();
    expect(getByText("GitOps")).toBeTruthy();
    getByText("Fleet").click();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("the cluster-name segment returns to Overview", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "homelab-nelli", section: "gitops" } });
    const { getByText } = render(<Breadcrumb />);
    getByText("homelab-nelli").click();
    expect(useFleet.getState().route).toMatchObject({ name: "cluster", cluster: "homelab-nelli", section: "overview" });
  });
  it("shows the kind crumb when a resource is selected", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource: { group: "cilium.io", version: "v2", plural: "ciliumendpoints", kind: "CiliumEndpoint", scope: "Namespaced" } } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("CiliumEndpoint")).toBeTruthy();
    expect(getByText("Resources")).toBeTruthy();
  });
});
