package appbridge

import (
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToFluxDTO(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 0, 30, 0, time.UTC)
	r := flux.Resource{
		Kind: flux.KustomizationKind, Namespace: "flux-system", Name: "flux-system",
		Ready: flux.Ready, Message: "", Revision: "main@sha1:abc",
		LastApplied: now.Add(-30 * time.Second), Suspended: false,
		SourceKind: "GitRepository", SourceName: "flux-system",
	}
	d := ToFluxDTO(r, now)
	if d.Kind != "Kustomization" || d.Name != "flux-system" || d.Namespace != "flux-system" {
		t.Fatalf("identity: %+v", d)
	}
	if d.Ready != "Ready" || d.Revision != "main@sha1:abc" {
		t.Fatalf("fields: %+v", d)
	}
	if d.LastAppliedAgeSeconds != 30 {
		t.Fatalf("age: %d", d.LastAppliedAgeSeconds)
	}
	if d.SourceKind != "GitRepository" || d.SourceName != "flux-system" {
		t.Fatalf("source: kind=%q name=%q", d.SourceKind, d.SourceName)
	}
}

func TestToFluxDTOZeroTimeAge(t *testing.T) {
	now := time.Now()
	d := ToFluxDTO(flux.Resource{Kind: flux.HelmReleaseKind, Name: "x", Ready: flux.Failed}, now)
	if d.LastAppliedAgeSeconds != 0 {
		t.Fatalf("want 0 age for zero time, got %d", d.LastAppliedAgeSeconds)
	}
}
