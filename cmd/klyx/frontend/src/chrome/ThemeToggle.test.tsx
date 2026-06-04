import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => localStorage.clear());

describe("ThemeToggle", () => {
  it("flips data-theme on click", () => {
    const { getByRole } = render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => getByRole("button").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
