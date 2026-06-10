import { useFleet } from "../store/fleet";
import { ExecService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { Clipboard } from "@wailsio/runtime";

type ExecCommandDTO = { command: string; argv: string[]; error: string };
type ActionResultDTO = { ok: boolean; error: string };

// getExecCommand fetches the kubectl exec argv and display command string.
// Returns null on bridge error (bridge-level throw).
export async function getExecCommand(
  cluster: string,
  ns: string,
  pod: string,
  container: string,
): Promise<ExecCommandDTO | null> {
  try {
    return (await ExecService.GetExecCommand(cluster, ns, pod, container)) as ExecCommandDTO;
  } catch {
    return null;
  }
}

// copyExecCommand calls GetExecCommand then copies the Command string to the
// clipboard. Returns "copied" | "error".
export async function copyExecCommand(
  cluster: string,
  ns: string,
  pod: string,
  container: string,
): Promise<"copied" | "error"> {
  const dto = await getExecCommand(cluster, ns, pod, container);
  if (!dto || dto.error) return "error";
  try {
    await Clipboard.SetText(dto.command);
    return "copied";
  } catch {
    return "error";
  }
}

// openExecTerminal calls OpenExecTerminal. On success nothing happens visually
// (the OS terminal opens). On error it sets actionStatus so the detail panel
// toast shows the message.
export async function openExecTerminal(
  cluster: string,
  ns: string,
  pod: string,
  container: string,
): Promise<void> {
  let result: ActionResultDTO | null = null;
  try {
    result = (await ExecService.OpenExecTerminal(cluster, ns, pod, container)) as ActionResultDTO;
  } catch {
    useFleet.getState().setActionStatus({ kind: "error", message: "Failed to launch terminal" });
    return;
  }
  if (!result?.ok) {
    useFleet.getState().setActionStatus({
      kind: "error",
      message: result?.error || "Failed to launch terminal",
    });
  }
  // Success: terminal opened — no toast needed.
}
