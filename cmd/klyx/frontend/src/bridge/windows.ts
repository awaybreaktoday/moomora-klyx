import { WindowsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

type ActionResultDTO = { ok: boolean; error: string };

// openLogsWindow asks the Go side to open a native window tailing one
// container's logs. Returns true on success. Errors (validation or bridge
// throw) resolve to false so callers can keep the dock open as a fallback.
export async function openLogsWindow(
  cluster: string,
  namespace: string,
  pod: string,
  container: string,
): Promise<boolean> {
  try {
    const r = (await WindowsService.OpenLogsWindow(cluster, namespace, pod, container)) as ActionResultDTO;
    return !!r?.ok;
  } catch {
    return false;
  }
}
