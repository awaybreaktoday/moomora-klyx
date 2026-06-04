package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWarningsFlagsShadowedTagKey(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{
		{Name: "homelab", Tags: map[string]string{"env": "homelab", "protected": "true"}},
	}}
	w := c.Warnings()
	if len(w) != 1 || !strings.Contains(w[0], "protected") || !strings.Contains(w[0], "homelab") {
		t.Fatalf("want one warning about protected on homelab, got %v", w)
	}
}

func TestWarningsCleanConfigNone(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{
		{Name: "dev", Tags: map[string]string{"env": "dev", "region": "we"}},
	}}
	if w := c.Warnings(); len(w) != 0 {
		t.Fatalf("want no warnings, got %v", w)
	}
}

func TestSummaryListsProtected(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{
		{Name: "prd", Protected: true}, {Name: "dev"},
	}}
	s := c.Summary()
	if !strings.Contains(s, "2 cluster") || !strings.Contains(s, "prd") {
		t.Fatalf("summary: %q", s)
	}
}

func TestLoadValidConfig(t *testing.T) {
	c, err := Load(filepath.Join("testdata", "fleet.yaml"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(c.Clusters) != 2 {
		t.Fatalf("want 2 clusters, got %d", len(c.Clusters))
	}
	first := c.Clusters[0]
	if first.Context != "prd-we" {
		t.Fatalf("want context prd-we, got %q", first.Context)
	}
	if first.Tags["env"] != "prd" {
		t.Fatalf("want env prd, got %q", first.Tags["env"])
	}
	if first.Metrics == nil || first.Metrics.Endpoint == "" {
		t.Fatalf("want metrics endpoint set")
	}
	// Context defaults to Name when omitted.
	if c.Clusters[1].Context != "vimadaboda-k3s" {
		t.Fatalf("want defaulted context, got %q", c.Clusters[1].Context)
	}
}

func TestLoadParsesEnvironmentAndProtected(t *testing.T) {
	cfg, err := Load("testdata/protected.yaml")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	byName := map[string]ClusterConfig{}
	for _, c := range cfg.Clusters {
		byName[c.Name] = c
	}
	if byName["prd-we"].Environment != "prd" || !byName["prd-we"].Protected {
		t.Fatalf("prd-we: %+v", byName["prd-we"])
	}
	if byName["dev-ne"].Environment != "dev" || byName["dev-ne"].Protected {
		t.Fatalf("dev-ne: %+v", byName["dev-ne"])
	}
}

func TestValidateRejectsDuplicateNames(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{{Name: "a"}, {Name: "a"}}}
	if err := c.validate(); err == nil {
		t.Fatal("expected duplicate-name error")
	}
}

func TestValidateRejectsEmptyName(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{{Name: ""}}}
	if err := c.validate(); err == nil {
		t.Fatal("expected empty-name error")
	}
}

func TestValidateRejectsNoClusters(t *testing.T) {
	c := &Config{}
	if err := c.validate(); err == nil {
		t.Fatal("expected no-clusters error")
	}
}
