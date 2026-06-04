package appbridge

import (
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToDetailDTOApplyFailed(t *testing.T) {
	d := flux.Detail{
		Kind: flux.KustomizationKind, Namespace: "flux-system", Name: "x",
		AppliedRevision: "main@a", AttemptedRevision: "main@b",
		Conditions: []flux.Condition{{Type: "Ready", Status: "False", Reason: "BuildFailed", Message: "boom"}},
		Inventory:  []flux.InventoryEntry{{Namespace: "ns", Name: "cm", Kind: "ConfigMap", Version: "v1"}},
	}
	dto := toDetailDTO(d)
	if !dto.ApplyFailed {
		t.Fatal("want ApplyFailed when attempted != applied")
	}
	if len(dto.Conditions) != 1 || dto.Conditions[0].Reason != "BuildFailed" {
		t.Fatalf("conditions: %+v", dto.Conditions)
	}
	if len(dto.Inventory) != 1 || dto.Inventory[0].Kind != "ConfigMap" {
		t.Fatalf("inventory: %+v", dto.Inventory)
	}
}

func TestToDetailDTOApplyOK(t *testing.T) {
	dto := toDetailDTO(flux.Detail{AppliedRevision: "main@a", AttemptedRevision: "main@a"})
	if dto.ApplyFailed {
		t.Fatal("want ApplyFailed false when equal")
	}
}

func TestGetResourceDetailReadsConn(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status": map[string]interface{}{
			"lastAppliedRevision": "main@a", "lastAttemptedRevision": "main@a",
			"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
		},
	}}
	conn := &fakeGitOpsConn{obj: obj}
	lookup := func(name string) (GitOpsConn, bool) {
		if name == "x" {
			return conn, true
		}
		return nil, false
	}
	svc := NewGitOpsService(lookup, &fakeEmitter{}, func() time.Time { return time.Now() }, time.Second)
	dto := svc.GetResourceDetail("x", "Kustomization", "flux-system", "flux-system")
	if dto.Name != "flux-system" || dto.Kind != "Kustomization" {
		t.Fatalf("detail: %+v", dto)
	}
	empty := svc.GetResourceDetail("ghost", "Kustomization", "a", "b")
	if empty.Name != "" {
		t.Fatalf("want zero DTO for unknown cluster, got %+v", empty)
	}
}
