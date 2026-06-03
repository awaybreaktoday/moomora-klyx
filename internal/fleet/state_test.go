package fleet

import "testing"

func TestTransitions(t *testing.T) {
	cases := []struct {
		from ConnState
		ev   Event
		want ConnState
		ok   bool
	}{
		{Unconnected, EvStart, Connecting, true},
		{Connecting, EvSynced, Synced, true},
		{Connecting, EvConnError, Failed, true},
		{Synced, EvCapUnhealthy, Degraded, true},
		{Degraded, EvCapHealthy, Synced, true},
		{Synced, EvWatchDrop, Stale, true},
		{Degraded, EvWatchDrop, Stale, true},
		{Stale, EvSynced, Synced, true},
		{Failed, EvStart, Connecting, true},
		{Synced, EvConnError, Failed, true},
		// illegal transition: cannot go Unconnected -> Synced directly
		{Unconnected, EvSynced, Unconnected, false},
	}
	for _, tc := range cases {
		got, ok := Transition(tc.from, tc.ev)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Transition(%v,%v) = (%v,%v), want (%v,%v)",
				tc.from, tc.ev, got, ok, tc.want, tc.ok)
		}
	}
}

func TestRecoveryTransitions(t *testing.T) {
	cases := []struct {
		from ConnState
		ev   Event
		want ConnState
		ok   bool
	}{
		{Failed, EvSynced, Synced, true},  // recovery from never-synced/connect-timeout
		{Stale, EvSynced, Synced, true},   // recovery from a dropped watch
	}
	for _, tc := range cases {
		got, ok := Transition(tc.from, tc.ev)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Transition(%v,%v) = (%v,%v), want (%v,%v)",
				tc.from, tc.ev, got, ok, tc.want, tc.ok)
		}
	}
}

func TestStateStringStable(t *testing.T) {
	if Synced.String() != "Synced" {
		t.Fatalf("want Synced, got %q", Synced.String())
	}
}
