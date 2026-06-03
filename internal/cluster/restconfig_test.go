package cluster

import (
	"path/filepath"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

func TestRESTConfigResolvesContext(t *testing.T) {
	cc := config.ClusterConfig{
		Name:       "plt-sea-prd-we-aks-01",
		Context:    "prd-we",
		Kubeconfig: filepath.Join("testdata", "kubeconfig.yaml"),
	}
	rc, err := RESTConfig(cc)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rc.Host != "https://prd-we.example:6443" {
		t.Fatalf("want resolved host, got %q", rc.Host)
	}
}

func TestRESTConfigErrorsOnMissingContext(t *testing.T) {
	cc := config.ClusterConfig{
		Name:       "x",
		Context:    "does-not-exist",
		Kubeconfig: filepath.Join("testdata", "kubeconfig.yaml"),
	}
	if _, err := RESTConfig(cc); err == nil {
		t.Fatal("expected error for unknown context")
	}
}
