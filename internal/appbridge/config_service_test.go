package appbridge

import (
	"errors"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

func testConfigService(t *testing.T, ctxs []string, scanErr error) *ConfigService {
	t.Helper()
	cfg := &config.Config{Clusters: []config.ClusterConfig{
		{Name: "homelab-nelli", Context: "kubernetes-admin@homelab-nelli", Tags: map[string]string{"env": "homelab"}, Protected: false},
		{Name: "prd-weu", Context: "prd-weu", Group: "prd", Protected: true, Metrics: &config.MetricsConfig{Endpoint: "http://prom"}},
	}}
	s := NewConfigService("/tmp/fleet.yaml", cfg)
	s.kubeconfigPath = func() string { return "/tmp/kubeconfig" }
	s.kubeContexts = func(string) ([]string, error) { return ctxs, scanErr }
	return s
}

func TestGetFleetConfig(t *testing.T) {
	s := testConfigService(t, []string{"kubernetes-admin@homelab-nelli", "kubernetes-admin@homelab-orange", "prd-weu"}, nil)
	dto := s.GetFleetConfig()

	if dto.Path != "/tmp/fleet.yaml" || dto.KubeconfigPath != "/tmp/kubeconfig" {
		t.Fatalf("paths wrong: %+v", dto)
	}
	if len(dto.Clusters) != 2 || dto.Clusters[0].Name != "homelab-nelli" || dto.Clusters[0].Env != "homelab" {
		t.Fatalf("clusters wrong: %+v", dto.Clusters)
	}
	if !dto.Clusters[1].Protected || !dto.Clusters[1].HasMetrics {
		t.Fatalf("protected/metrics flags wrong: %+v", dto.Clusters[1])
	}
	// nelli + prd-weu are in fleet (by context/name); orange is not.
	want := map[string]bool{
		"kubernetes-admin@homelab-nelli":  true,
		"kubernetes-admin@homelab-orange": false,
		"prd-weu":                         true,
	}
	for _, c := range dto.Contexts {
		if c.InFleet != want[c.Name] {
			t.Errorf("context %q inFleet: got %v, want %v", c.Name, c.InFleet, want[c.Name])
		}
	}
	if n := s.NewContextCount(); n != 1 {
		t.Fatalf("new-context badge: got %d, want 1", n)
	}
}

func TestGetFleetConfigScanError(t *testing.T) {
	s := testConfigService(t, nil, errors.New("kubeconfig unreadable"))
	dto := s.GetFleetConfig()
	if dto.ScanError == "" || len(dto.Contexts) != 0 {
		t.Fatalf("scan error must surface, contexts empty: %+v", dto)
	}
	if s.NewContextCount() != 0 {
		t.Fatal("badge must be 0 on scan failure, never invented")
	}
}

func TestAddClusters(t *testing.T) {
	s := testConfigService(t, nil, nil)
	var got []string
	s.appendClusters = func(path string, ctxs []string) error {
		if path != "/tmp/fleet.yaml" {
			t.Fatalf("path: %s", path)
		}
		got = ctxs
		return nil
	}
	r := s.AddClusters([]string{"ctx-new"})
	if !r.OK || len(got) != 1 || got[0] != "ctx-new" {
		t.Fatalf("add: %+v / %v", r, got)
	}
	if r := s.AddClusters(nil); r.OK || r.Error == "" {
		t.Fatalf("empty add must fail: %+v", r)
	}
	s.appendClusters = func(string, []string) error { return errors.New("boom") }
	if r := s.AddClusters([]string{"x"}); r.OK || r.Error != "boom" {
		t.Fatalf("append error must surface: %+v", r)
	}
}
