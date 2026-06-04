package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ks(status string, reason string, suspend bool, rev, msg string) *unstructured.Unstructured {
	conds := []interface{}{
		map[string]interface{}{"type": "Ready", "status": status, "reason": reason, "message": msg},
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"spec":       map[string]interface{}{"suspend": suspend},
		"status": map[string]interface{}{
			"conditions":          conds,
			"lastAppliedRevision": rev,
		},
	}}
}

func TestParseKustomizationReady(t *testing.T) {
	r := ParseKustomization(ks("True", "ReconciliationSucceeded", false, "main@sha1:abc1234", ""))
	if r.Kind != KustomizationKind {
		t.Fatalf("kind: %q", r.Kind)
	}
	if r.Name != "flux-system" || r.Namespace != "flux-system" {
		t.Fatalf("name/ns: %+v", r)
	}
	if r.Ready != Ready {
		t.Fatalf("ready: %q", r.Ready)
	}
	if r.Revision != "main@sha1:abc1234" {
		t.Fatalf("revision: %q", r.Revision)
	}
	if r.Suspended {
		t.Fatalf("should not be suspended")
	}
}

func TestParseKustomizationFailedAndSuspended(t *testing.T) {
	r := ParseKustomization(ks("False", "BuildFailed", true, "", "kustomize build failed"))
	if r.Ready != Failed {
		t.Fatalf("want Failed, got %q", r.Ready)
	}
	if r.Message != "kustomize build failed" {
		t.Fatalf("message: %q", r.Message)
	}
	if !r.Suspended {
		t.Fatalf("want suspended")
	}
}

func TestParseKustomizationReconciling(t *testing.T) {
	u := ks("Unknown", "Progressing", false, "", "reconciliation in progress")
	conds := u.Object["status"].(map[string]interface{})["conditions"].([]interface{})
	conds = append(conds, map[string]interface{}{"type": "Reconciling", "status": "True"})
	u.Object["status"].(map[string]interface{})["conditions"] = conds
	r := ParseKustomization(u)
	if r.Ready != Reconciling {
		t.Fatalf("want Reconciling, got %q", r.Ready)
	}
}

func TestParseHelmReleaseReadyRevisionFromHistory(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2",
		"kind":       "HelmRelease",
		"metadata":   map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"spec":       map[string]interface{}{},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "message": "Helm install succeeded"},
			},
			"history": []interface{}{
				map[string]interface{}{"chartVersion": "1.16.5"},
			},
		},
	}}
	r := ParseHelmRelease(u)
	if r.Kind != HelmReleaseKind || r.Name != "cilium" {
		t.Fatalf("identity: %+v", r)
	}
	if r.Ready != Ready {
		t.Fatalf("ready: %q", r.Ready)
	}
	if r.Revision != "1.16.5" {
		t.Fatalf("revision: %q", r.Revision)
	}
}
