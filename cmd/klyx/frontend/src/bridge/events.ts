import { useFleet, EventsResultDTO } from "../store/fleet";
import { EventsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listEvents(cluster: string, namespace: string): Promise<void> {
  useFleet.getState().setEventsLoading(cluster, namespace);
  try {
    const r = (await EventsService.ListEvents(cluster, namespace)) as EventsResultDTO;
    // Drop a stale response if the user changed cluster OR namespace while in flight.
    const cur = useFleet.getState().events;
    if (cur.cluster !== cluster || cur.namespace !== namespace) return;
    useFleet.getState().setEvents(cluster, namespace, r ?? { namespaces: [], events: [] });
  } catch {
    // Clear the loading flag so the view doesn't get stuck on "Loading…".
    if (useFleet.getState().events.cluster === cluster) {
      useFleet.setState((s) => ({ events: { ...s.events, loading: false } }));
    }
  }
}
