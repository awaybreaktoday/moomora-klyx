package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ksWithDependsOn() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "apps", "namespace": "flux-system"},
		"spec": map[string]interface{}{
			"dependsOn": []interface{}{
				map[string]interface{}{"name": "infra"},
				map[string]interface{}{"name": "db", "namespace": "data"},
			},
		},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "False", "reason": "DependencyNotReady", "message": "dependency 'flux-system/infra' is not ready"},
			},
		},
	}}
}

func TestParseKustomizationDependsOn(t *testing.T) {
	r := ParseKustomization(ksWithDependsOn())
	if r.Reason != "DependencyNotReady" {
		t.Fatalf("reason: %q", r.Reason)
	}
	if len(r.DependsOn) != 2 {
		t.Fatalf("dependsOn len: %d (%+v)", len(r.DependsOn), r.DependsOn)
	}
	// namespace defaults to the resource's own
	if r.DependsOn[0] != (DependencyRef{Namespace: "flux-system", Name: "infra"}) {
		t.Fatalf("dep0: %+v", r.DependsOn[0])
	}
	// explicit namespace preserved
	if r.DependsOn[1] != (DependencyRef{Namespace: "data", Name: "db"}) {
		t.Fatalf("dep1: %+v", r.DependsOn[1])
	}
}

func TestParseDetailDependsOnAndReason(t *testing.T) {
	d := ParseDetail(ksWithDependsOn())
	if d.Reason != "DependencyNotReady" {
		t.Fatalf("detail reason: %q", d.Reason)
	}
	if len(d.DependsOn) != 2 || d.DependsOn[1].Name != "db" {
		t.Fatalf("detail dependsOn: %+v", d.DependsOn)
	}
}

func TestParseDependsOnEmpty(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Kustomization",
		"metadata": map[string]interface{}{"name": "x", "namespace": "y"},
		"spec":     map[string]interface{}{},
	}}
	if r := ParseKustomization(u); len(r.DependsOn) != 0 {
		t.Fatalf("want no deps, got %+v", r.DependsOn)
	}
}
