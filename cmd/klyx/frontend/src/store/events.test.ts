import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleet";
import type { EventsResultDTO, EventRowDTO } from "./fleet";

const warning: EventRowDTO = {
  type: "Warning", reason: "BackOff", message: "back-off restarting failed container",
  count: 5, namespace: "default", kind: "Pod", name: "api-crash",
  lastSeenUnix: 1700000100, firstSeenUnix: 1700000000,
};
const normal: EventRowDTO = {
  type: "Normal", reason: "Pulled", message: "Successfully pulled image",
  count: 1, namespace: "monitoring", kind: "Pod", name: "grafana-xyz",
  lastSeenUnix: 1700000200, firstSeenUnix: 1700000200,
};

const allResult: EventsResultDTO = { namespaces: ["default", "monitoring"], events: [warning, normal] };

describe("events slice", () => {
  beforeEach(() => useFleet.getState().clearEvents());

  it("setEvents populates items and namespaces on all-load", () => {
    useFleet.getState().setEvents("c", "", allResult);
    const s = useFleet.getState().events;
    expect(s.items).toHaveLength(2);
    expect(s.namespaces).toEqual(["default", "monitoring"]);
    expect(s.loading).toBe(false);
  });

  it("setEvents preserves namespaces on scoped load", () => {
    useFleet.getState().setEvents("c", "", allResult);
    useFleet.getState().setEvents("c", "default", { namespaces: [], events: [warning] });
    expect(useFleet.getState().events.namespaces).toEqual(["default", "monitoring"]);
  });

  it("setEvents falls back to [namespace] when first load is scoped", () => {
    useFleet.getState().setEvents("c", "team", { namespaces: [], events: [] });
    expect(useFleet.getState().events.namespaces).toEqual(["team"]);
  });

  it("setEventsLoading marks loading true", () => {
    useFleet.getState().setEventsLoading("c", "default");
    expect(useFleet.getState().events.loading).toBe(true);
    expect(useFleet.getState().events.namespace).toBe("default");
  });

  it("toggleWarningsOnly flips the flag", () => {
    expect(useFleet.getState().events.warningsOnly).toBe(false);
    useFleet.getState().toggleWarningsOnly();
    expect(useFleet.getState().events.warningsOnly).toBe(true);
    useFleet.getState().toggleWarningsOnly();
    expect(useFleet.getState().events.warningsOnly).toBe(false);
  });

  it("setEventsSearch stores the search string", () => {
    useFleet.getState().setEventsSearch("crash");
    expect(useFleet.getState().events.search).toBe("crash");
  });

  it("clearEvents resets everything including live", () => {
    useFleet.getState().setEvents("c", "", allResult);
    useFleet.getState().toggleWarningsOnly();
    useFleet.getState().setEventsSearch("foo");
    // Manually set live to true.
    useFleet.setState((s) => ({ events: { ...s.events, live: true } }));
    useFleet.getState().clearEvents();
    const s = useFleet.getState().events;
    expect(s.items).toHaveLength(0);
    expect(s.namespaces).toHaveLength(0);
    expect(s.warningsOnly).toBe(false);
    expect(s.search).toBe("");
    expect(s.cluster).toBeNull();
    expect(s.live).toBe(false);
  });

  it("setEventsLive updates live when cluster+namespace match", () => {
    useFleet.getState().setEvents("c", "", allResult);
    useFleet.getState().setEventsLive("c", "", true);
    expect(useFleet.getState().events.live).toBe(true);
    useFleet.getState().setEventsLive("c", "", false);
    expect(useFleet.getState().events.live).toBe(false);
  });

  it("setEventsLive stale-guard: wrong cluster is a no-op", () => {
    useFleet.getState().setEvents("c", "", allResult);
    useFleet.getState().setEventsLive("other", "", true);
    expect(useFleet.getState().events.live).toBe(false);
  });

  it("setEventsLive stale-guard: wrong namespace is a no-op", () => {
    useFleet.getState().setEvents("c", "default", { namespaces: ["default"], events: [warning] });
    useFleet.getState().setEventsLive("c", "monitoring", true);
    expect(useFleet.getState().events.live).toBe(false);
  });
});
