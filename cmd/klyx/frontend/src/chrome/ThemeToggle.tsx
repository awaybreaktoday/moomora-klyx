import { IconSun, IconMoon } from "@tabler/icons-react";
import { useTheme } from "../theme/ThemeProvider";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      title="Toggle theme"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0,
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        color: "var(--color-text-primary)", cursor: "pointer",
      }}
    >
      {theme === "light" ? <IconMoon size={16} stroke={1.5} /> : <IconSun size={16} stroke={1.5} />}
    </button>
  );
}
