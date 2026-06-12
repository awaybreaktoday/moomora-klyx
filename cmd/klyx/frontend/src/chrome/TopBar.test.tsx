import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useFleet } from "../store/fleet";
import type { ForwardDTO } from "../store/fleet";

// Mock the forwards bridge so no Wails runtime is needed; assert dispatches.
vi.mock("../bridge/forwards", () => ({
  stopForward: vi.fn().mockResolvedValue(undefined),
  stopAllForwards: vi.fn().mockResolvedValue(undefined),
}));
import { stopAllForwards } from "../bridge/forwards";

// ThemeToggle touches matchMedia; stub it.
vi.mock("./ThemeToggle", () => ({ ThemeToggle: () => null }));

const active: ForwardDTO = {
  id: "c/team/api#1",
  cluster: "dev",
  namespace: "team",
  targetKind: "Pod",
  targetName: "api",
  localPort: 34567,
  targetPort: 8080,
  startedUnix: 1700000000,
  status: "active",
};
const broken: ForwardDTO = { ...active, id: "c/team/web#2", targetName: "web", status: "broken" };

describe("TopBar forwards indicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFleet.getState().setForwards([]);
  });

  it("renders nothing when there are no forwards", () => {
    const { queryByTestId } = render(<TopBar />);
    expect(queryByTestId("forwards-chip")).toBeNull();
  });

  it("renders the chip with the forward count", () => {
    useFleet.getState().setForwards([active, broken]);
    const { getByTestId } = render(<TopBar />);
    const chip = getByTestId("forwards-chip");
    expect(chip.textContent).toContain("2");
  });

  it("clicking a row navigates to the forwards section and closes the panel", () => {
    useFleet.getState().setForwards([active]);
    const { getByTestId, queryByTestId } = render(<TopBar />);
    fireEvent.click(getByTestId("forwards-chip"));
    fireEvent.click(getByTestId(`forward-row-${active.id}`));
    expect(useFleet.getState().route).toEqual({ name: "forwards" });
    expect(queryByTestId("forwards-panel")).toBeNull();
  });

  it("dispatches stop all", () => {
    useFleet.getState().setForwards([active, broken]);
    const { getByTestId } = render(<TopBar />);
    fireEvent.click(getByTestId("forwards-chip"));
    fireEvent.click(getByTestId("forwards-stop-all"));
    expect(stopAllForwards).toHaveBeenCalled();
  });

  it("styles a broken row with the warning colour", () => {
    useFleet.getState().setForwards([broken]);
    const { getByTestId } = render(<TopBar />);
    fireEvent.click(getByTestId("forwards-chip"));
    const row = getByTestId(`forward-row-${broken.id}`);
    // Broken rows render warning-coloured (presence assertion on the token).
    expect(row.getAttribute("style")).toContain("var(--color-text-warning)");
    expect(row.textContent).toContain("broken");
  });

  it("has no per-row stop buttons - management lives in the Forwards section", () => {
    useFleet.getState().setForwards([active, broken]);
    const { getByTestId, queryByTestId } = render(<TopBar />);
    fireEvent.click(getByTestId("forwards-chip"));
    expect(queryByTestId(`forward-stop-${active.id}`)).toBeNull();
    expect(queryByTestId("forwards-view-all")).toBeNull();
  });
});
