import { useRef, useState, useCallback } from "react";

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
 */

const PLAIN_THRESHOLD = 100;

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  render: (item: T, index: number) => React.ReactNode;
  /** Optional style applied to the outer container div (height/flex-1 etc.) */
  style?: React.CSSProperties;
}

export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 8,
  render,
  style,
}: VirtualListProps<T>) {
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

  // Plain render for short lists — no virtualization overhead.
  if (items.length < PLAIN_THRESHOLD) {
    return (
      <div style={style}>
        {items.map((item, i) => render(item, i))}
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
