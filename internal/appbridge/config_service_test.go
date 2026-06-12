package appbridge

import (
	"errors"
	"strings"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

func testConfigService(t *testing.T, ctxs []string, scanErr error) *ConfigService {
	t.Helper()
	cfg := &config.Config{Clusters: []config.ClusterConfig{
		{Name: "homelab-nelli", Context: "kubernetes-admin@homelab-nelli", Tags: map[string]string{"env": "homelab"}, Protected: false},
		{Name: "prd-weu", Context: "prd-weu", Group: "prd", Protected: true, Metrics: &config.MetricsConfig{Endpoint: "http://prom"}},
	}}
	s := NewConfigService("/tmp/fleet.yaml", cfg, nil)
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

func TestAddClustersHotAddsToRunningFleet(t *testing.T) {
	s := testConfigService(t, []string{"ctx-new"}, nil)
	s.appendClusters = func(string, []string) error { return nil }
	var connected []string
	s.connect = func(cc config.ClusterConfig) error {
		if cc.Name != cc.Context {
			t.Fatalf("minimal entry must use name=context, got %+v", cc)
		}
		connected = append(connected, cc.Name)
		return nil
	}

	if r := s.AddClusters([]string{"ctx-new"}); !r.OK {
		t.Fatalf("AddClusters failed: %+v", r)
	}
	if len(connected) != 1 || connected[0] != "ctx-new" {
		t.Fatalf("connect not called: %v", connected)
	}
	// The session view reflects the addition without a restart.
	dto := s.GetFleetConfig()
	if len(dto.Clusters) != 3 {
		t.Fatalf("hot-added cluster missing from GetFleetConfig: %+v", dto.Clusters)
	}
	for _, c := range dto.Contexts {
		if c.Name == "ctx-new" && !c.InFleet {
			t.Fatal("hot-added context must report inFleet")
		}
	}
	if got := s.NewContextCount(); got != 0 {
		t.Fatalf("badge must drop to 0 after hot-add, got %d", got)
	}
}

func TestAddClustersReportsConnectFailureHonestly(t *testing.T) {
	s := testConfigService(t, []string{"ctx-bad"}, nil)
	s.appendClusters = func(string, []string) error { return nil }
	s.connect = func(config.ClusterConfig) error { return errors.New("no such context") }

	r := s.AddClusters([]string{"ctx-bad"})
	if r.OK {
		t.Fatal("connect failure must not report full success")
	}
	for _, want := range []string{"fleet.yaml", "ctx-bad", "no such context", "Restart Klyx"} {
		if !strings.Contains(r.Error, want) {
			t.Fatalf("error %q missing %q", r.Error, want)
		}
	}
	// Not connected -> not claimed as in-fleet for the session.
	if got := len(s.GetFleetConfig().Clusters); got != 2 {
		t.Fatalf("failed connect must not join the session fleet, got %d clusters", got)
	}
}
