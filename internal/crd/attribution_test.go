package crd

import "testing"

func TestOperatorPriority(t *testing.T) {
	if got := Operator(map[string]string{"app.kubernetes.io/name": "envoy-gateway", "app.kubernetes.io/managed-by": "Helm"}); got != "envoy-gateway" {
		t.Fatalf("name priority: %q", got)
	}
	if got := Operator(map[string]string{"app.kubernetes.io/part-of": "cilium"}); got != "cilium" {
		t.Fatalf("part-of: %q", got)
	}
	if got := Operator(map[string]string{"helm.sh/chart": "cert-manager-v1.14.2"}); got != "cert-manager" {
		t.Fatalf("chart version strip: %q", got)
	}
	if got := Operator(map[string]string{"app.kubernetes.io/managed-by": "flux"}); got != "flux" {
		t.Fatalf("managed-by: %q", got)
	}
	if got := Operator(map[string]string{"unrelated": "x"}); got != "" {
		t.Fatalf("unknown -> empty, got %q", got)
	}
}

func TestCategory(t *testing.T) {
	cases := map[string]string{
		"cilium.io":                 "CNI",
		"source.toolkit.fluxcd.io":  "GITOPS",
		"argoproj.io":               "GITOPS",
		"cert-manager.io":           "PKI",
		"gateway.networking.k8s.io": "NETWORK",
		"gateway.envoyproxy.io":     "NETWORK",
		"external-secrets.io":       "SECRETS",
		"monitoring.coreos.com":     "OBSERV",
		"postgresql.cnpg.io":        "DATABASE",
		"unknown.example.com":       "",
	}
	for group, want := range cases {
		if got := Category(group); got != want {
			t.Fatalf("Category(%q)=%q want %q", group, got, want)
		}
	}
}
