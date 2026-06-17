package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func gitRepoObj(ready string, reason string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1",
		"kind":       "GitRepository",
		"metadata":   map[string]interface{}{"name": "podinfo", "namespace": "flux-system"},
		"spec":       map[string]interface{}{"url": "https://github.com/org/repo"},
		"status": map[string]interface{}{
			"artifact": map[string]interface{}{"revision": "main@sha1:abcdef0"},
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": ready, "reason": reason, "message": "stored artifact"},
			},
		},
	}}
}

func TestParseSourceReady(t *testing.T) {
	s := ParseSource(gitRepoObj("True", "Succeeded"))
	if s.Kind != GitRepositoryKind || s.Name != "podinfo" || s.Namespace != "flux-system" {
		t.Fatalf("identity: %+v", s)
	}
	if s.Ready != Ready {
		t.Fatalf("ready: %q", s.Ready)
	}
	if s.Revision != "main@sha1:abcdef0" {
		t.Fatalf("revision: %q", s.Revision)
	}
	if s.URL != "https://github.com/org/repo" {
		t.Fatalf("url: %q", s.URL)
	}
}

func TestParseSourceFailedCarriesReason(t *testing.T) {
	s := ParseSource(gitRepoObj("False", "GitOperationFailed"))
	if s.Ready != Failed || s.Reason != "GitOperationFailed" {
		t.Fatalf("failed source: %+v", s)
	}
}

func TestParseSourceSuspended(t *testing.T) {
	u := gitRepoObj("True", "Succeeded")
	_ = unstructured.SetNestedField(u.Object, true, "spec", "suspend")
	if s := ParseSource(u); !s.Suspended {
		t.Fatalf("expected suspended source: %+v", s)
	}
}

func TestBoundSourceKustomization(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Kustomization",
		"metadata": map[string]interface{}{"name": "apps", "namespace": "flux-system"},
		"spec": map[string]interface{}{
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"},
		},
	}}
	b, ok := BoundSource(u)
	if !ok || b.Kind != "GitRepository" || b.Name != "flux-system" || b.Namespace != "flux-system" {
		t.Fatalf("bound: %+v ok=%v", b, ok)
	}
}

func TestBoundSourceHelmReleaseChartRef(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "HelmRelease",
		"metadata": map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"spec": map[string]interface{}{
			"chartRef": map[string]interface{}{"kind": "OCIRepository", "name": "cilium", "namespace": "flux-system"},
		},
	}}
	b, ok := BoundSource(u)
	if !ok || b.Kind != "OCIRepository" || b.Name != "cilium" || b.Namespace != "flux-system" {
		t.Fatalf("bound: %+v ok=%v", b, ok)
	}
}

func TestBoundSourceHelmReleaseChartTemplate(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "HelmRelease",
		"metadata": map[string]interface{}{"name": "podinfo", "namespace": "apps"},
		"spec": map[string]interface{}{
			"chart": map[string]interface{}{
				"spec": map[string]interface{}{
					"sourceRef": map[string]interface{}{"kind": "HelmRepository", "name": "podinfo"},
				},
			},
		},
	}}
	b, ok := BoundSource(u)
	if !ok || b.Kind != "HelmRepository" || b.Name != "podinfo" || b.Namespace != "apps" {
		t.Fatalf("bound: %+v ok=%v", b, ok)
	}
}

func TestBoundSourceNone(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Kustomization",
		"metadata": map[string]interface{}{"name": "x", "namespace": "y"},
		"spec":     map[string]interface{}{},
	}}
	if _, ok := BoundSource(u); ok {
		t.Fatal("expected no bound source")
	}
}
