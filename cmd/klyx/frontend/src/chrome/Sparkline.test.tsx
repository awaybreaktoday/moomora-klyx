import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders 'no data' for an empty series", () => {
    const { getByText, queryByRole } = render(<Sparkline points={[]} />);
    expect(getByText("no data")).toBeTruthy();
    expect(queryByRole("img")).toBeNull();
  });

  it("renders a single polyline for a continuous series", () => {
    const points = [
      { t: 0, v: 1 },
      { t: 60, v: 2 },
      { t: 120, v: 1.5 },
    ];
    const { container } = render(<Sparkline points={points} />);
    expect(container.querySelectorAll("polyline").length).toBe(1);
  });

  it("breaks the line at gaps instead of interpolating", () => {
    // 60s step with a hole between 120 and 360 -> two segments.
    const points = [
      { t: 0, v: 1 },
      { t: 60, v: 2 },
      { t: 120, v: 1 },
      { t: 360, v: 3 },
      { t: 420, v: 2 },
    ];
    const { container } = render(<Sparkline points={points} />);
    expect(container.querySelectorAll("polyline").length).toBe(2);
  });

  it("renders an isolated point between gaps as a dot", () => {
    const points = [
      { t: 0, v: 1 },
      { t: 60, v: 2 },
      { t: 600, v: 5 }, // lone sample
      { t: 1200, v: 1 },
      { t: 1260, v: 1 },
    ];
    const { container } = render(<Sparkline points={points} />);
    expect(container.querySelectorAll("polyline").length).toBe(2);
    expect(container.querySelectorAll("circle").length).toBe(1);
  });

  it("a flat all-zero series still draws a line", () => {
    const points = [
      { t: 0, v: 0 },
      { t: 60, v: 0 },
    ];
    const { container } = render(<Sparkline points={points} />);
    const line = container.querySelector("polyline");
    expect(line).toBeTruthy();
    // Both y coordinates sit on the baseline (height - pad = 22 for default 24px).
    expect(line!.getAttribute("points")).toContain("22.0");
  });
});
