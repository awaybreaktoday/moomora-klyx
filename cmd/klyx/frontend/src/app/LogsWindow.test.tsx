import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { LogsWindow } from "./LogsWindow";

// Capture event subscriptions so the LogsPane stream lifecycle resolves.
const eventHandlers: Record<string, ((ev: { data: unknown }) => void)[]> = {};
vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: vi.fn((eventName: string, handler: (ev: { data: unknown }) => void) => {
      (eventHandlers[eventName] ??= []).push(handler);
      return () => {
        eventHandlers[eventName] = (eventHandlers[eventName] || []).filter((h) => h !== handler);
      };
    }),
  },
}));

const mockOpenLogStream = vi.fn();
const mockCloseLogStream = vi.fn();
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  LogsService: {
    OpenLogStream: (...args: unknown[]) => mockOpenLogStream(...args),
    CloseLogStream: (...args: unknown[]) => mockCloseLogStream(...args),
    CloseAll: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("LogsWindow", () => {
  beforeEach(() => {
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    mockOpenLogStream.mockReset();
    mockCloseLogStream.mockReset();
    mockCloseLogStream.mockResolvedValue(undefined);
    mockOpenLogStream.mockResolvedValue({ streamId: "s1", error: undefined });
  });
  afterEach(() => vi.clearAllMocks());

  function seeded() {
    return new URLSearchParams(
      "?logswin=1&cluster=prod-aks&ns=monitoring&pod=grafana-7d4&container=grafana",
    );
  }

  it("renders header with ns/pod and cluster from params", () => {
    const { getByTestId, getByText } = render(<LogsWindow params={seeded()} />);
    const win = getByTestId("logs-window");
    expect(win).toBeTruthy();
    // ns/pod present
    expect(win.textContent).toContain("monitoring");
    expect(win.textContent).toContain("grafana-7d4");
    // cluster muted
    expect(getByText("prod-aks")).toBeTruthy();
  });

  it("opens the stream on the container param (static container, empty containers list)", async () => {
    render(<LogsWindow params={seeded()} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(1));
    expect(mockOpenLogStream).toHaveBeenCalledWith(
      "prod-aks", "monitoring", "grafana-7d4", "grafana", false, 500,
    );
  });

  it("does not render the expand button when hosted in window", async () => {
    const { queryByRole } = render(<LogsWindow params={seeded()} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalled());
    expect(queryByRole("button", { name: /expand logs/i })).toBeNull();
  });
});
