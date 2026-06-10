import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResizableDock } from "./useResizableDock";

const STORAGE_KEY = "klyx-logs-dock-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;

// jsdom reports window.innerHeight as 0 by default. Set a realistic value so
// the max-height clamp (60% of innerHeight) gives a sensible upper bound.
const INNER_HEIGHT = 800;
const MAX_HEIGHT = Math.floor(INNER_HEIGHT * 0.6); // 480

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: INNER_HEIGHT });
});
afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("useResizableDock", () => {
  it("returns default height when storage is empty", () => {
    const { result } = renderHook(() => useResizableDock());
    expect(result.current.height).toBe(DEFAULT_HEIGHT);
  });

  it("reads initial height from localStorage", () => {
    localStorage.setItem(STORAGE_KEY, "400");
    const { result } = renderHook(() => useResizableDock());
    expect(result.current.height).toBe(400);
  });

  it("clamps stored height to MIN", () => {
    localStorage.setItem(STORAGE_KEY, "50");
    const { result } = renderHook(() => useResizableDock());
    expect(result.current.height).toBe(MIN_HEIGHT);
  });

  it("clamps stored height to MAX (60% innerHeight)", () => {
    localStorage.setItem(STORAGE_KEY, "9999");
    const { result } = renderHook(() => useResizableDock());
    expect(result.current.height).toBe(MAX_HEIGHT);
  });

  it("falls back to default for non-numeric stored value", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useResizableDock());
    expect(result.current.height).toBe(DEFAULT_HEIGHT);
  });

  it("enlarges dock when dragging up (negative clientY delta)", () => {
    const { result } = renderHook(() => useResizableDock());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientY: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    act(() => {
      // Move pointer 40px up (clientY = 460): delta = 500 - 460 = 40.
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientY: 460,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.height).toBe(DEFAULT_HEIGHT + 40); // 360
  });

  it("shrinks dock when dragging down (positive clientY delta)", () => {
    localStorage.setItem(STORAGE_KEY, "400");
    const { result } = renderHook(() => useResizableDock());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientY: 300,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    act(() => {
      // Move down by 80px: delta = 300 - 380 = -80 → 400 - 80 = 320.
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientY: 380,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.height).toBe(320);
  });

  it("clamps height to MIN when dragged far down", () => {
    const { result } = renderHook(() => useResizableDock());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientY: 300,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientY: 9999,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.height).toBe(MIN_HEIGHT);
  });

  it("clamps height to MAX when dragged far up", () => {
    const { result } = renderHook(() => useResizableDock());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientY: 300,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.handleProps.onPointerMove({
        currentTarget: handleEl,
        clientY: -9999,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    expect(result.current.height).toBe(MAX_HEIGHT);
  });

  it("persists to localStorage on pointerup", () => {
    const { result } = renderHook(() => useResizableDock());
    const handleEl = document.createElement("div");
    handleEl.setPointerCapture = () => {};

    act(() => {
      result.current.handleProps.onPointerDown({
        currentTarget: handleEl,
        pointerId: 1,
        clientY: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      // Drag 60px up: delta = 60 → 320 + 60 = 380.
      result.current.handleProps.onPointerUp({
        currentTarget: handleEl,
        clientY: 440,
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });

    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).toBe(String(DEFAULT_HEIGHT + 60)); // "380"
  });

  it("handle style uses row-resize cursor and is on the top edge", () => {
    const { result } = renderHook(() => useResizableDock());
    const s = result.current.handleProps.style;
    expect(s.cursor).toBe("row-resize");
    expect(s.top).toBe(0);
    expect(s.height).toBe(4);
    expect(s.position).toBe("absolute");
  });
});
