import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Sidebar } from "./Sidebar";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("Sidebar", () => {
  it("Fleet icon returns to the grid", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("Fleet").click();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("a section icon is disabled at the fleet root", () => {
    const { getByLabelText } = render(<Sidebar />);
    expect((getByLabelText("GitOps") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a section icon sets the section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("GitOps").click();
    expect(useFleet.getState().route).toMatchObject({ name: "cluster", section: "gitops" });
  });
});
