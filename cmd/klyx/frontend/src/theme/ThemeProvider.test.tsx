import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function Toggle() {
  const { theme, toggle } = useTheme();
  return <button onClick={toggle}>{theme}</button>;
}

describe("ThemeProvider", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to light and sets data-theme on the root", () => {
    render(<ThemeProvider><Toggle /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggles to dark and persists", () => {
    const { getByRole } = render(<ThemeProvider><Toggle /></ThemeProvider>);
    act(() => getByRole("button").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("klyx-theme")).toBe("dark");
  });
});
