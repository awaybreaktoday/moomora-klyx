import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { ActionToast } from "./ActionToast";
import { useFleet } from "../store/fleet";

beforeEach(() => {
  useFleet.getState().clearActionStatus();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  useFleet.getState().clearActionStatus();
});

describe("ActionToast", () => {
  it("renders nothing when actionStatus is null", () => {
    const { container } = render(<ActionToast />);
    expect(container.firstChild).toBeNull();
  });

  it("renders success message with success colour", () => {
    act(() => {
      useFleet.getState().setActionStatus({ kind: "success", message: "Reconcile requested" });
    });
    const { getByRole } = render(<ActionToast />);
    const toast = getByRole("status");
    expect(toast.textContent).toBe("Reconcile requested");
    expect(toast.style.color).toContain("success");
  });

  it("renders error message with danger colour", () => {
    act(() => {
      useFleet.getState().setActionStatus({ kind: "error", message: "Operation failed" });
    });
    const { getByRole } = render(<ActionToast />);
    const toast = getByRole("status");
    expect(toast.textContent).toBe("Operation failed");
    expect(toast.style.color).toContain("danger");
  });

  it("clicking toast dismisses it", () => {
    act(() => {
      useFleet.getState().setActionStatus({ kind: "success", message: "Done" });
    });
    const { getByRole, queryByRole } = render(<ActionToast />);
    fireEvent.click(getByRole("status"));
    expect(queryByRole("status")).toBeNull();
    expect(useFleet.getState().actionStatus).toBeNull();
  });

  it("auto-dismisses after 6s", () => {
    act(() => {
      useFleet.getState().setActionStatus({ kind: "success", message: "Auto dismiss" });
    });
    render(<ActionToast />);
    expect(useFleet.getState().actionStatus).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(useFleet.getState().actionStatus).toBeNull();
  });

  it("resets the auto-dismiss timer when status changes", () => {
    act(() => {
      useFleet.getState().setActionStatus({ kind: "success", message: "First" });
    });
    render(<ActionToast />);
    act(() => {
      vi.advanceTimersByTime(5000); // 5s — not yet dismissed
    });
    expect(useFleet.getState().actionStatus?.message).toBe("First");

    // Replace status — timer should reset
    act(() => {
      useFleet.getState().setActionStatus({ kind: "error", message: "Second" });
    });
    act(() => {
      vi.advanceTimersByTime(5000); // 5s from the new status — still active
    });
    expect(useFleet.getState().actionStatus?.message).toBe("Second");

    act(() => {
      vi.advanceTimersByTime(1000); // +1s = 6s total from second — dismissed
    });
    expect(useFleet.getState().actionStatus).toBeNull();
  });
});
