import { ThemeToggle } from "./ThemeToggle";

// Wails v3 window-drag regions: the bar is draggable, interactive children opt out.
const drag = { "--wails-draggable": "drag" } as React.CSSProperties;
const noDrag = { "--wails-draggable": "no-drag" } as React.CSSProperties;

// TopBar is the full-width title bar: macOS traffic lights sit on its left (the
// padding clears them), the theme toggle on its right, and the empty middle
// drags the window. The breadcrumb lives in the content Header so it aligns with
// the view title and body.
export function TopBar() {
  return (
    <div
      style={{
        ...drag,
        display: "flex",
        alignItems: "center",
        height: 40,
        flexShrink: 0,
        paddingLeft: 84,
        paddingRight: 12,
        background: "var(--color-background-secondary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
      }}
    >
      <div style={{ flex: 1 }} />
      <div style={noDrag}>
        <ThemeToggle />
      </div>
    </div>
  );
}
