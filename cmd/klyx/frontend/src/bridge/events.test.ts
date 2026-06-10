import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFleet } from "../store/fleet";

vi.mock("../../bindings/github.com/moomora/klyx/internal/appbridge/index.js", () => ({
  EventsService: {
    ListEvents: vi.fn().mockResolvedValue({ namespaces: [], events: [] }),
    OpenLiveEvents: vi.fn().mockResolvedValue({ ok: true, error: "" }),
    CloseLiveEvents: vi.fn().mockResolvedValue(undefined),
    CloseAll: vi.fn().mockResolvedValue(undefined),
  },
}));

const eventHandlers: Record<string, (ev: unknown) => void> = {};
const offFns: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: vi.fn((name: string, handler: (ev: unknown) => void) => {
      eventHandlers[name] = handler;
      const off = vi.fn();
      offFns[name] = off;
      return off;
    }),
  },
}));

import { EventsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";
import { Events } from "@wailsio/runtime";
import { openLiveEvents } from "./events";

function seedEvents(cluster: string, namespace: string) {
  useFleet.setState((s) => ({
    events: { ...s.events, cluster, namespace, items: [], namespaces: [], loading: false },
  }));
}

describe("openLiveEvents bridge", () => {
  beforeEach(() => {
    useFleet.getState().clearEvents();
    vi.clearAllMocks();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    for (const k of Object.keys(offFns)) delete offFns[k];
  });

  it("subscribes to data and status events and calls OpenLiveEvents", () => {
    seedEvents("homelab", "");
    openLiveEvents("homelab", "");

    expect(Events.On).toHaveBeenCalledWith("liveEvents:homelab:", expect.any(Function));
    expect(Events.On).toHaveBeenCalledWith("liveEventsStatus:homelab:", expect.any(Function));
    expect(EventsService.OpenLiveEvents).toHaveBeenCalledWith("homelab", "");
  });

  it("data event payload updates the events store", () => {
    seedEvents("homelab", "");
    openLiveEvents("homelab", "");

    const handler = eventHandlers["liveEvents:homelab:"];
    expect(handler).toBeDefined();
    handler({ data: { namespaces: ["default", "monitoring"], events: [] } });

    expect(useFleet.getState().events.namespaces).toEqual(["default", "monitoring"]);
  });

  it("status event sets live flag in store", () => {
    seedEvents("homelab", "");
    openLiveEvents("homelab", "");

    const statusHandler = eventHandlers["liveEventsStatus:homelab:"];
    expect(statusHandler).toBeDefined();
    statusHandler({ data: { live: true } });

    expect(useFleet.getState().events.live).toBe(true);
  });

  it("cleanup unsubscribes both events and calls CloseLiveEvents", () => {
    seedEvents("homelab", "");
    const cleanup = openLiveEvents("homelab", "");

    cleanup();

    expect(offFns["liveEvents:homelab:"]!).toHaveBeenCalled();
    expect(offFns["liveEventsStatus:homelab:"]!).toHaveBeenCalled();
    expect(EventsService.CloseLiveEvents).toHaveBeenCalledWith("homelab", "");
  });

  it("stale-guard: data event for wrong cluster is dropped", () => {
    seedEvents("homelab", "");
    openLiveEvents("other-cluster", "");

    const handler = eventHandlers["liveEvents:other-cluster:"];
    expect(handler).toBeDefined();
    handler({ data: { namespaces: ["injected"], events: [] } });

    // Store is seeded as "homelab"; update for "other-cluster" must be dropped.
    expect(useFleet.getState().events.namespaces).toHaveLength(0);
  });
});
