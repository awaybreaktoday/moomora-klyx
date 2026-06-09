import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { LogsPane } from "./LogsPane";
import type { ContainerSummaryDTO } from "../store/fleet";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Capture event handlers so we can fire them in tests.
const eventHandlers: Record<string, ((ev: { data: unknown }) => void)[]> = {};
const offFns: (() => void)[] = [];

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: vi.fn((eventName: string, handler: (ev: { data: unknown }) => void) => {
      if (!eventHandlers[eventName]) eventHandlers[eventName] = [];
      eventHandlers[eventName].push(handler);
      const off = () => {
        eventHandlers[eventName] = (eventHandlers[eventName] || []).filter((h) => h !== handler);
      };
      offFns.push(off);
      return off;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireChunk(eventName: string, lines: string[], eof = false, error?: string) {
  const handlers = eventHandlers[eventName] ?? [];
  for (const h of handlers) {
    h({ data: { lines, eof, error } });
  }
}

const makeContainer = (overrides: Partial<ContainerSummaryDTO> = {}): ContainerSummaryDTO => ({
  name: "app", image: "nginx:latest", ready: true, restarts: 0, state: "running", init: false, ...overrides,
});

const defaultPod = {
  namespace: "default",
  name: "my-pod",
  containers: [makeContainer({ name: "app" }), makeContainer({ name: "sidecar" })],
};

const defaultPodWithInit = {
  namespace: "default",
  name: "my-pod",
  containers: [
    makeContainer({ name: "app" }),
    makeContainer({ name: "init-setup", init: true }),
  ],
};

const openSuccess = (streamId = "stream-1") =>
  Promise.resolve({ streamId, error: undefined });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LogsPane", () => {
  beforeEach(() => {
    // Reset handlers and mocks before each test
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    offFns.length = 0;
    mockOpenLogStream.mockReset();
    mockCloseLogStream.mockReset();
    mockCloseLogStream.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls OpenLogStream with defaults on mount (500 tail, first regular container)", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess());
    render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(1));
    expect(mockOpenLogStream).toHaveBeenCalledWith(
      "homelab", "default", "my-pod", "app", false, 500,
    );
  });

  it("shows 'connecting' then 'streaming' after stream opens", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess());
    const { getByText } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    // Before stream resolves, status is connecting
    expect(getByText("connecting…")).toBeTruthy();
    await waitFor(() => expect(getByText("streaming")).toBeTruthy());
  });

  it("renders received log lines", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s1"));
    const { getByText } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(eventHandlers["podlogs:s1"]).toBeDefined());

    act(() => {
      fireChunk("podlogs:s1", ["line one", "line two"]);
    });

    await waitFor(() => expect(getByText("line one")).toBeTruthy());
    expect(getByText("line two")).toBeTruthy();
  });

  it("shows 'ended' status on EOF and unsubscribes", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-eof"));
    const { getByText } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(eventHandlers["podlogs:s-eof"]).toBeDefined());

    act(() => {
      fireChunk("podlogs:s-eof", [], true);
    });

    await waitFor(() => expect(getByText("ended")).toBeTruthy());
    // Handler should have been removed (off() called)
    expect(eventHandlers["podlogs:s-eof"]?.length ?? 0).toBe(0);
  });

  it("calls CloseLogStream on unmount", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-unmount"));
    const { unmount } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(eventHandlers["podlogs:s-unmount"]).toBeDefined());

    unmount();

    await waitFor(() => expect(mockCloseLogStream).toHaveBeenCalledWith("s-unmount"));
  });

  it("closes old stream and opens new stream on container switch", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-initial"));
    const { getByRole, unmount } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(1));

    // Switch container
    mockOpenLogStream.mockImplementation(() => openSuccess("s-new"));
    const select = getByRole("combobox", { name: /container/i });
    act(() => {
      fireEvent.change(select, { target: { value: "sidecar" } });
    });

    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(2));
    expect(mockCloseLogStream).toHaveBeenCalledWith("s-initial");
    expect(mockOpenLogStream).toHaveBeenLastCalledWith(
      "homelab", "default", "my-pod", "sidecar", false, 500,
    );

    unmount();
  });

  it("clears buffer when clear is clicked (stream continues)", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-clear"));
    const { getByText, queryByText } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(eventHandlers["podlogs:s-clear"]).toBeDefined());

    act(() => {
      fireChunk("podlogs:s-clear", ["hello world"]);
    });
    await waitFor(() => expect(getByText("hello world")).toBeTruthy());

    act(() => {
      fireEvent.click(getByText("clear"));
    });

    // Buffer cleared, line gone
    expect(queryByText("hello world")).toBeNull();
    // Stream still alive (no extra CloseLogStream call at this point)
    expect(mockCloseLogStream).not.toHaveBeenCalled();
  });

  it("highlights search matches and shows match count", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-search"));
    const { getByPlaceholderText, getByText } = render(
      <LogsPane cluster="homelab" pod={defaultPod} />,
    );
    await waitFor(() => expect(eventHandlers["podlogs:s-search"]).toBeDefined());

    act(() => {
      fireChunk("podlogs:s-search", ["hello world", "goodbye world", "no match here"]);
    });
    await waitFor(() => expect(getByText("no match here")).toBeTruthy());

    act(() => {
      fireEvent.change(getByPlaceholderText("search"), { target: { value: "world" } });
    });

    // match count shown
    await waitFor(() => expect(getByText("2 matches")).toBeTruthy());
    // "world" appears in <mark> tags
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBe(2);
  });

  it("shows error status when OpenLogStream returns an error", async () => {
    mockOpenLogStream.mockResolvedValue({ streamId: "", error: "no such pod" });
    const { getByText } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(getByText(/error:.*no such pod/i)).toBeTruthy());
  });

  it("shows init containers labeled in select", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-init"));
    const { getByRole } = render(<LogsPane cluster="homelab" pod={defaultPodWithInit} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalled());
    const select = getByRole("combobox", { name: /container/i }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.text);
    expect(options).toContain("app");
    expect(options.some((o) => o.startsWith("init:"))).toBe(true);
  });

  it("opens with previous=true when previous chip is toggled", async () => {
    mockOpenLogStream.mockImplementation(() => openSuccess("s-prev"));
    const { getByText, unmount } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(1));

    mockOpenLogStream.mockImplementation(() => openSuccess("s-prev2"));
    act(() => {
      fireEvent.click(getByText("previous"));
    });

    await waitFor(() => expect(mockOpenLogStream).toHaveBeenCalledTimes(2));
    expect(mockOpenLogStream).toHaveBeenLastCalledWith(
      "homelab", "default", "my-pod", "app", true, 500,
    );
    unmount();
  });

  it("guard: open resolving after unmount closes the stream immediately", async () => {
    let resolveOpen!: (v: { streamId: string }) => void;
    mockOpenLogStream.mockImplementation(
      () => new Promise<{ streamId: string }>((r) => { resolveOpen = r; }),
    );
    const { unmount } = render(<LogsPane cluster="homelab" pod={defaultPod} />);
    // Unmount BEFORE the promise resolves
    unmount();
    // Now resolve the promise — stale guard should close the stream immediately
    act(() => { resolveOpen({ streamId: "s-late" }); });
    await waitFor(() => expect(mockCloseLogStream).toHaveBeenCalledWith("s-late"));
  });
});
