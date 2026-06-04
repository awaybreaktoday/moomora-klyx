package flux

import (
	"testing"
	"time"
)

func TestReconcilePatchBytes(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	got := string(ReconcilePatch(now))
	want := `{"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":"2026-06-04T12:00:00Z"}}}`
	if got != want {
		t.Fatalf("want %s, got %s", want, got)
	}
}

func TestSuspendPatchBytes(t *testing.T) {
	if got := string(SuspendPatch(true)); got != `{"spec":{"suspend":true}}` {
		t.Fatalf("suspend true: got %s", got)
	}
	if got := string(SuspendPatch(false)); got != `{"spec":{"suspend":false}}` {
		t.Fatalf("suspend false: got %s", got)
	}
}

func TestResourceForKind(t *testing.T) {
	if r, ok := ResourceForKind(KustomizationKind); !ok || r != "kustomizations" {
		t.Fatalf("kustomization: %q %v", r, ok)
	}
	if r, ok := ResourceForKind(HelmReleaseKind); !ok || r != "helmreleases" {
		t.Fatalf("helmrelease: %q %v", r, ok)
	}
	if _, ok := ResourceForKind(Kind("Bogus")); ok {
		t.Fatal("bogus kind must not resolve")
	}
}
