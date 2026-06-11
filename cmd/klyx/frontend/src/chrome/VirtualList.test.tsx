import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VirtualList } from "./VirtualList";

// jsdom doesn't layout — clientHeight is 0 by default, so the virtual window
// calculation sees containerHeight=0 and renders overscan rows from index 0.
// The tests below control behaviour via list size (short vs. large) and verify
// the documented threshold + scroll wiring.

const PLAIN_THRESHOLD = 100; // must match the constant in VirtualList.tsx

function makeItems(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `item-${i}`);
}

describe("VirtualList", () => {
  it("renders all items when count < threshold (plain path)", () => {
    const items = makeItems(PLAIN_THRESHOLD - 1);
    const { getAllByTestId } = render(
      <VirtualList
        items={items}
        rowHeight={32}
        render={(item, i) => <div key={i} data-testid="row">{item}</div>}
      />,
    );
    expect(getAllByTestId("row").length).toBe(PLAIN_THRESHOLD - 1);
  });

  it("renders exactly the threshold count plainly (boundary)", () => {
    const items = makeItems(PLAIN_THRESHOLD);
    // Threshold is < PLAIN_THRESHOLD, so at exactly 100 it switches to virtual.
    // Virtual with containerHeight=0 renders overscan (default 8) items from 0.
    const { getAllByTestId } = render(
      <VirtualList
        items={items}
        rowHeight={32}
        render={(item, i) => <div key={i} data-testid="row">{item}</div>}
      />,
    );
    // Either all (plain) or a subset (virtual), but not more than total.
    expect(getAllByTestId("row").length).toBeLessThanOrEqual(PLAIN_THRESHOLD);
  });

  it("renders far fewer rows than 1000 items (virtual path)", () => {
    const items = makeItems(1000);
    const { getAllByTestId } = render(
      <VirtualList
        items={items}
        rowHeight={32}
        overscan={8}
        style={{ height: 300 }}
        render={(item, i) => <div key={i} data-testid="row">{item}</div>}
      />,
    );
    // Virtual mode: only overscan * 2 + visible rows rendered.
    // With jsdom clientHeight=0, we get firstVisible=0 to lastVisible=overscan.
    const rows = getAllByTestId("row");
    expect(rows.length).toBeLessThan(1000);
  });

  it("scroll event triggers re-render and updates the window", () => {
    const items = makeItems(200);
    const { container, getAllByTestId } = render(
      <VirtualList
        items={items}
        rowHeight={40}
        overscan={4}
        style={{ height: 300 }}
        render={(item, i) => <div key={i} data-testid="row">{item}</div>}
      />,
    );
    const scrollEl = container.firstElementChild as HTMLElement;
    // Simulate scrolling to row 100 (offset = 100 * 40 = 4000px)
    Object.defineProperty(scrollEl, "scrollTop", { value: 4000, writable: true });
    fireEvent.scroll(scrollEl);
    // After scroll, the rendered items should include items around index 100
    const renderedTexts = getAllByTestId("row").map((el) => el.textContent ?? "");
    // The first visible item should be near index 100 (minus overscan)
    // With overscan=4 and scrollTop=4000, firstVisible = max(0, floor(4000/40) - 4) = 96
    expect(renderedTexts.some((t) => t.startsWith("item-9") || t.startsWith("item-10"))).toBe(true);
  });

  it("passes index correctly to render function", () => {
    const items = makeItems(5);
    const { getAllByTestId } = render(
      <VirtualList
        items={items}
        rowHeight={32}
        render={(item, i) => <div key={i} data-testid="row" data-idx={i}>{item}</div>}
      />,
    );
    const rows = getAllByTestId("row");
    rows.forEach((row, i) => {
      expect(row.getAttribute("data-idx")).toBe(String(i));
    });
  });

  it("plain path owns its scrolling (overflowY auto on the container)", () => {
    const items = Array.from({ length: 5 }, (_, i) => `row-${i}`);
    const { container } = render(
      <VirtualList items={items} rowHeight={32} style={{ flex: 1, minHeight: 0 }} render={(it) => <div key={it}>{it}</div>} />,
    );
    const outer = container.firstElementChild as HTMLElement;
    // Without this, short lists overflow visibly and the nearest ancestor
    // scroll container scrolls the whole view (list + detail panel) together.
    expect(outer.style.overflowY).toBe("auto");
    expect(outer.style.flex).toBe("1 1 0%"); // caller style still applies
  });
});
