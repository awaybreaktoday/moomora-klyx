import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

describe("ThemeToggle", () => {
  it("opens a theme menu and selects midnight", () => {
    const { getByLabelText, getByRole } = render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(getByLabelText("Theme: Light"));
    expect(getByRole("menuitemradio", { name: "Crimson" })).toBeTruthy();
    fireEvent.click(getByRole("menuitemradio", { name: "Midnight" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
    expect(localStorage.getItem("klyx-theme")).toBe("midnight");
  });
});
