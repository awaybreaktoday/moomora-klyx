import { useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";

/**
 * VirtualList — lightweight windowed list renderer.
 *
 * Threshold: when items.length < PLAIN_THRESHOLD (100), renders all items
 * directly without virtualization — avoids overhead for short lists and keeps
 * snapshot tests trivially correct.
 *
 * Fixed-height rows constraint: rows must be fixed height (single-line grid
 * rows). Variable-height content (e.g. EventsView expanded message rows)
 * breaks the math. Callers are expected to detect that case and bail to plain
 * rendering — see EventsView for the documented pattern.
 *
 * scrollToIndex: exposed via forwardRef/useImperativeHandle. Plain path (<100
 * items) scrolls the matching row into view via a data attribute lookup on the
 * container element. Virtual path sets scrollTop = idx * rowHeight directly on
 * the container.
 */

const PLAIN_THRESHOLD = 100;

export type VirtualListHandle = {
  scrollToIndex: (idx: number) => void;
};

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  render: (item: T, index: number) => React.ReactNode;
  /** Optional style applied to the outer container div (height/flex-1 etc.) */
  style?: React.CSSProperties;
}

// forwardRef with generics requires the inner function to be typed carefully.
// We export a wrapper that re-asserts the generic so call sites remain typed.
function VirtualListInner<T>(
  { items, rowHeight, overscan = 8, render, style }: VirtualListProps<T>,
  ref: React.Ref<VirtualListHandle>,
) {
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = (e.currentTarget as HTMLDivElement).scrollTop;
    if (rafRef.current !== null) return; // already queued
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setScrollTop(top);
    });
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToIndex(idx: number) {
      const el = containerRef.current;
      if (!el) return;
      if (items.length < PLAIN_THRESHOLD) {
        // Plain path: rows are direct children; find by data-vl-idx attribute.
        const row = el.querySelector(`[data-vl-idx="${idx}"]`);
        if (row && typeof (row as HTMLElement).scrollIntoView === "function") {
          (row as HTMLElement).scrollIntoView({ block: "nearest" });
        }
      } else {
        // Virtual path: compute offset and set scrollTop imperatively.
        el.scrollTop = idx * rowHeight;
      }
    },
  }), [items.length, rowHeight]);

  // Plain render for short lists — no virtualization overhead.
  if (items.length < PLAIN_THRESHOLD) {
    return (
      <div ref={containerRef} style={style}>
        {items.map((item, i) => (
          <div key={i} data-vl-idx={i} style={{ display: "contents" }}>
            {render(item, i)}
          </div>
        ))}
      </div>
    );
  }

  const totalHeight = items.length * rowHeight;
  const containerHeight = containerRef.current?.clientHeight ?? 600;

  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const lastVisible = Math.min(
    items.length - 1,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + overscan,
  );

  const visibleItems = items.slice(firstVisible, lastVisible + 1);
  const offsetY = firstVisible * rowHeight;

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ height: "100%", overflowY: "auto", position: "relative", ...style }}
    >
      {/* Spacer that forces the scrollbar to the correct total height */}
      <div style={{ height: totalHeight, position: "relative" }}>
        {/* Visible window, absolutely positioned to the current scroll position */}
        <div style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
          {visibleItems.map((item, i) => render(item, firstVisible + i))}
        </div>
      </div>
    </div>
  );
}

// Cast to preserve generic typing across the forwardRef boundary.
export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: React.Ref<VirtualListHandle> },
) => React.ReactElement;
