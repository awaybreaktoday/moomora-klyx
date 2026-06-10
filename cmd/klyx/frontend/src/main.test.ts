import { describe, it, expect, vi } from "vitest";

// main.tsx renders into #root as a side effect on import, so we mock react-dom
// to a no-op before importing it; we only want the exported isLogsWindow helper.
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: () => {} }) },
}));
vi.mock("./theme/tokens.css", () => ({}));

import { isLogsWindow } from "./main";

describe("isLogsWindow", () => {
  it("returns true when logswin=1", () => {
    expect(isLogsWindow("?logswin=1&cluster=prod&ns=default&pod=web")).toBe(true);
  });

  it("returns false when logswin absent", () => {
    expect(isLogsWindow("?cluster=prod")).toBe(false);
    expect(isLogsWindow("")).toBe(false);
  });

  it("returns false when logswin has any other value", () => {
    expect(isLogsWindow("?logswin=0")).toBe(false);
    expect(isLogsWindow("?logswin=true")).toBe(false);
  });
});
