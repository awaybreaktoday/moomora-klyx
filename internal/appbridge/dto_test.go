package appbridge

import (
	"testing"
	"time"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/fleet"
)

func TestToDTO(t *testing.T) {
	now := time.Date(2026, 6, 3, 12, 0, 30, 0, time.UTC)
	snap := fleet.Snapshot{
		Name:       "plt-sea-prd-we-aks-01",
		State:      fleet.Synced,
		NodesReady: 12, NodesTotal: 12, Pods: 487,
		Version:  "v1.30.4",
		LastSync: now.Add(-15 * time.Second),
		Capabilities: capability.Set{
			GitOps:  capability.GitOpsCapability{Base: capability.Base{Tier: capability.Healthy}},
			Network: capability.NetworkCapability{Base: capability.Base{Tier: capability.Degraded, Reason: "no EnvoyProxy"}},
		},
	}
	cc := config.ClusterConfig{
		Name:  "plt-sea-prd-we-aks-01",
		Group: "prd-we",
		Tags:  map[string]string{"env": "prd", "region": "we", "provider": "aks"},
	}

	d := ToDTO(snap, cc, now)
	if d.Name != "plt-sea-prd-we-aks-01" {
		t.Fatalf("name: %q", d.Name)
	}
	if d.State != "Synced" {
		t.Fatalf("state: %q", d.State)
	}
	if d.NodesReady != 12 || d.NodesTotal != 12 || d.Pods != 487 {
		t.Fatalf("counts: %+v", d)
	}
	if d.Version != "v1.30.4" {
		t.Fatalf("version: %q", d.Version)
	}
	if d.Env != "prd" || d.Region != "we" || d.Provider != "aks" || d.Group != "prd-we" {
		t.Fatalf("tags: %+v", d)
	}
	if d.GitopsTier != "Healthy" {
		t.Fatalf("gitops tier: %q", d.GitopsTier)
	}
	if d.NetworkTier != "Degraded" || d.NetworkReason != "no EnvoyProxy" {
		t.Fatalf("network: %q/%q", d.NetworkTier, d.NetworkReason)
	}
	if d.AgeSeconds != 15 {
		t.Fatalf("age: %d", d.AgeSeconds)
	}
}

func TestToDTOZeroLastSyncAgeIsZero(t *testing.T) {
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	d := ToDTO(fleet.Snapshot{Name: "x", State: fleet.Connecting}, config.ClusterConfig{Name: "x"}, now)
	if d.AgeSeconds != 0 {
		t.Fatalf("want 0 age when never synced, got %d", d.AgeSeconds)
	}
}
