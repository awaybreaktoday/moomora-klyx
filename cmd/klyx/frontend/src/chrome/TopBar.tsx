import { Breadcrumb } from "./Breadcrumb";
import { ThemeToggle } from "./ThemeToggle";

// Wails v3 window-drag regions: the bar is draggable, interactive children opt out.
const drag = { "--wails-draggable": "drag" } as React.CSSProperties;
const noDrag = { "--wails-draggable": "no-drag" } as React.CSSProperties;

// TopBar is a full-width title bar. Its left padding clears the macOS traffic
// lights, so the OS controls sit on a single uniform surface (no sidebar/content
// seam running through them). Empty areas drag the window.
export function TopBar() {
  return (
    <div
      style={{
        ...drag,
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 40,
        flexShrink: 0,
        paddingLeft: 84,
        paddingRight: 12,
        background: "var(--color-background-secondary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
      }}
    >
      <div style={noDrag}>
        <Breadcrumb />
      </div>
      <div style={{ flex: 1 }} />
      <div style={noDrag}>
        <ThemeToggle />
      </div>
    </div>
  );
}
