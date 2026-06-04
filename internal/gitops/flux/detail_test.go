package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ksDetailObj() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status": map[string]interface{}{
			"lastAppliedRevision":   "main@sha1:abc",
			"lastAttemptedRevision": "main@sha1:abc",
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "reason": "ReconciliationSucceeded", "message": "Applied revision: main@sha1:abc"},
				map[string]interface{}{"type": "Healthy", "status": "True", "reason": "Succeeded", "message": "Health check passed"},
			},
			"inventory": map[string]interface{}{
				"entries": []interface{}{
					map[string]interface{}{"id": "flux-system_infrastructure_kustomize.toolkit.fluxcd.io_Kustomization", "v": "v1"},
					map[string]interface{}{"id": "monitoring_my-cm__ConfigMap", "v": "v1"},
					map[string]interface{}{"id": "_cluster-admin_rbac.authorization.k8s.io_ClusterRole", "v": "v1"},
				},
			},
		},
	}}
}

func TestParseDetailKustomization(t *testing.T) {
	d := ParseDetail(ksDetailObj())
	if d.Kind != KustomizationKind || d.Name != "flux-system" {
		t.Fatalf("identity: %+v", d)
	}
	if d.AppliedRevision != "main@sha1:abc" || d.AttemptedRevision != "main@sha1:abc" {
		t.Fatalf("revisions: %+v", d)
	}
	if len(d.Conditions) != 2 || d.Conditions[0].Type != "Ready" || d.Conditions[1].Type != "Healthy" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if d.Conditions[1].Message != "Health check passed" {
		t.Fatalf("healthy message: %q", d.Conditions[1].Message)
	}
	if len(d.Inventory) != 3 {
		t.Fatalf("inventory len: %d", len(d.Inventory))
	}
	if d.Inventory[0] != (InventoryEntry{Namespace: "flux-system", Name: "infrastructure", Group: "kustomize.toolkit.fluxcd.io", Kind: "Kustomization", Version: "v1"}) {
		t.Fatalf("entry0: %+v", d.Inventory[0])
	}
	if d.Inventory[1] != (InventoryEntry{Namespace: "monitoring", Name: "my-cm", Group: "", Kind: "ConfigMap", Version: "v1"}) {
		t.Fatalf("entry1: %+v", d.Inventory[1])
	}
	if d.Inventory[2] != (InventoryEntry{Namespace: "", Name: "cluster-admin", Group: "rbac.authorization.k8s.io", Kind: "ClusterRole", Version: "v1"}) {
		t.Fatalf("entry2: %+v", d.Inventory[2])
	}
}

func TestParseDetailHelmReleaseNoInventory(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2",
		"kind":       "HelmRelease",
		"metadata":   map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "message": "Helm install succeeded"},
			},
		},
	}}
	d := ParseDetail(u)
	if d.Kind != HelmReleaseKind {
		t.Fatalf("kind: %q", d.Kind)
	}
	if len(d.Inventory) != 0 {
		t.Fatalf("helmrelease should have no inventory, got %d", len(d.Inventory))
	}
	if len(d.Conditions) != 1 {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
}
