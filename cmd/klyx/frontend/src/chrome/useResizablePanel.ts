import { useState, useCallback, useRef } from "react";

const STORAGE_KEY = "klyx-panel-width";
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 480;

function clamp(value: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? DEFAULT_WIDTH : clamp(n);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export interface ResizablePanelHandle {
  width: number;
  /** Spread {...handleProps} onto the drag handle div. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    style: React.CSSProperties;
  };
}

/**
 * useResizablePanel — returns a panel width and drag-handle props.
 *
 * The handle is a 4 px vertical strip placed on the LEFT edge of the panel.
 * Drag left to widen, right to narrow. Width is clamped to [360, 720] and
 * persisted to localStorage["klyx-panel-width"] — shared across all three
 * detail panels (Pods, Nodes, Helm).
 */
export function useResizablePanel(): ResizablePanelHandle {
  const [width, setWidth] = useState<number>(readStored);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Dragging left (negative delta) widens the panel; handle is on the LEFT edge.
    const delta = startX.current - e.clientX;
    const next = clamp(startWidth.current + delta);
    setWidth(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    const delta = startX.current - e.clientX;
    const final = clamp(startWidth.current + delta);
    setWidth(final);
    try {
      localStorage.setItem(STORAGE_KEY, String(final));
    } catch {
      // localStorage not available in test / sandboxed environments — ignore.
    }
  }, []);

  return {
    width,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        cursor: "col-resize",
        zIndex: 10,
        background: "transparent",
      } satisfies React.CSSProperties,
    },
  };
}
