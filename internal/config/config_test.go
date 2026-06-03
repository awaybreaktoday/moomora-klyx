package config

import (
	"path/filepath"
	"testing"
)

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
