import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EmptyState } from "./EmptyState";
import { SkeletonRows } from "./SkeletonRows";

describe("EmptyState", () => {
  it("renders title and optional hint", () => {
    const { getByText, getByTestId } = render(
      <EmptyState title="No pods." hint="Adjust the filter." />,
    );
    expect(getByTestId("empty-state")).toBeTruthy();
    expect(getByText("No pods.")).toBeTruthy();
    expect(getByText("Adjust the filter.")).toBeTruthy();
  });
});

describe("SkeletonRows", () => {
  it("announces as a labelled loading status with shimmer bars", () => {
    const { getByRole, container } = render(<SkeletonRows rows={4} label="loading pods" />);
    expect(getByRole("status", { name: "loading pods" })).toBeTruthy();
    expect(container.querySelectorAll(".klyx-skeleton").length).toBeGreaterThan(8); // 4 rows × (dot + bars)
  });
});
