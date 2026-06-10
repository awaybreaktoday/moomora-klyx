import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResizablePanel } from "./useResizablePanel";

const STORAGE_KEY = "klyx-panel-width";
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("useResizablePanel", () => {
  it("returns default width when storage is empty", () => {
    const { result } = renderHook(() => useResizablePanel());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });

  it("reads initial width from localStorage", () => {
    localStorage.setItem(STORAGE_KEY, "600");
    const { result } = renderHook(() => useResizablePanel());
    expect(result.current.width).toBe(600);
  });

  it("clamps stored width to MIN", () => {
    localStorage.setItem(STORAGE_KEY, "100");
    const { result } = renderHook(() => useResizablePanel());
    expect(result.current.width).toBe(MIN_WIDTH);
  });

  it("clamps stored width to MAX", () => {
    localStorage.setItem(STORAGE_KEY, "9999");
    const { result } = renderHook(() => useResizablePanel());
    expect(result.current.width).toBe(MAX_WIDTH);
  });

  it("falls back to default for non-numeric stored value", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useResizablePanel());
    expect(result.current.width).toBe(DEFAULT_WIDTH);
  });

  it("expands panel width when dragging left (negative clientX delta)", () => {
    const { result } = renderHook(() => useResizablePanel());
    const handleEl = document.createElement("div");
    // Mock setPointerCapture so the jsdom element doesn't throw.
    handleEl.setPointerCapture = () => {};

    act(() => {
      // Simulate pointerdown at x=500 with current width 480.
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    act(() => {
      // Move pointer 40px to the left (clientX = 460): delta = 500 - 460 = 40.
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientX: 460,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.width).toBe(DEFAULT_WIDTH + 40); // 520
  });

  it("narrows panel when dragging right (positive clientX delta)", () => {
    localStorage.setItem(STORAGE_KEY, "600");
    const { result } = renderHook(() => useResizablePanel());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    act(() => {
      // Move right by 100px: delta = 500 - 600 = -100 → 600 - 100 = 500.
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientX: 600,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.width).toBe(500);
  });

  it("clamps width to MIN when dragged far right", () => {
    const { result } = renderHook(() => useResizablePanel());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientX: 9999,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.width).toBe(MIN_WIDTH);
  });

  it("clamps width to MAX when dragged far left", () => {
    const { result } = renderHook(() => useResizablePanel());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientX: -9999,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.width).toBe(MAX_WIDTH);
  });

  it("persists to localStorage on pointerup", () => {
    const { result } = renderHook(() => useResizablePanel());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.handleProps.onPointerUp({
        currentTarget: handleEl,
        clientX: 440,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).toBe(String(DEFAULT_WIDTH + 60)); // 540
  });
});
