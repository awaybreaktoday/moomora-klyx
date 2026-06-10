import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFleet } from "../store/fleet";

// Mock bindings and runtime before importing the bridge.
vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  ExecService: {
    GetExecCommand: vi.fn(),
    OpenExecTerminal: vi.fn(),
  },
}));

vi.mock("@wailsio/runtime", () => ({
  Clipboard: {
    SetText: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ExecService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { Clipboard } from "@wailsio/runtime";
import { copyExecCommand, openExecTerminal } from "./exec";

beforeEach(() => {
  useFleet.getState().clearActionStatus();
  vi.clearAllMocks();
});

// --- copyExecCommand ---

describe("copyExecCommand", () => {
  it("calls GetExecCommand with correct args and copies Command to clipboard", async () => {
    (ExecService.GetExecCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      command: "kubectl --context prod -n default exec -it web-abc -c web -- /bin/sh -c 'command -v bash >/dev/null && exec bash || exec sh'",
      argv: ["kubectl", "--context", "prod", "-n", "default", "exec", "-it", "web-abc", "-c", "web", "--", "/bin/sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"],
      error: "",
    });

    const result = await copyExecCommand("prod", "default", "web-abc", "web");

    expect(result).toBe("copied");
    expect(ExecService.GetExecCommand).toHaveBeenCalledWith("prod", "default", "web-abc", "web");
    expect(Clipboard.SetText).toHaveBeenCalledWith(
      "kubectl --context prod -n default exec -it web-abc -c web -- /bin/sh -c 'command -v bash >/dev/null && exec bash || exec sh'",
    );
  });

  it("returns error when bridge returns error field", async () => {
    (ExecService.GetExecCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      command: "",
      argv: [],
      error: "cluster not connected: prod",
    });

    const result = await copyExecCommand("prod", "default", "web-abc", "");
    expect(result).toBe("error");
    expect(Clipboard.SetText).not.toHaveBeenCalled();
  });

  it("returns error when bridge throws", async () => {
    (ExecService.GetExecCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));

    const result = await copyExecCommand("prod", "default", "web-abc", "");
    expect(result).toBe("error");
  });
});

// --- openExecTerminal ---

describe("openExecTerminal", () => {
  it("calls OpenExecTerminal with correct args and sets no actionStatus on success", async () => {
    (ExecService.OpenExecTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, error: "" });

    await openExecTerminal("prod", "default", "web-abc", "web");

    expect(ExecService.OpenExecTerminal).toHaveBeenCalledWith("prod", "default", "web-abc", "web");
    expect(useFleet.getState().actionStatus).toBeNull();
  });

  it("sets error actionStatus when service returns error", async () => {
    (ExecService.OpenExecTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "open-terminal not supported on this platform yet - use copy command",
    });

    await openExecTerminal("prod", "default", "web-abc", "");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("error");
    expect(status?.message).toContain("open-terminal not supported");
  });

  it("sets error actionStatus when bridge throws", async () => {
    (ExecService.OpenExecTerminal as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc error"));

    await openExecTerminal("prod", "default", "web-abc", "web");

    const status = useFleet.getState().actionStatus;
    expect(status?.kind).toBe("error");
  });
});
