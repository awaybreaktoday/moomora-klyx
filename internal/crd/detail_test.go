package crd

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestParseConditions(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "reason": "OK", "message": "all good"},
				map[string]interface{}{"type": "Synced", "status": "False", "reason": "Err", "message": "boom"},
			},
		},
	}}
	cs := ParseConditions(u.Object)
	if len(cs) != 2 {
		t.Fatalf("want 2 conditions, got %d", len(cs))
	}
	if cs[0].Type != "Ready" || cs[0].Status != "True" || cs[0].Message != "all good" {
		t.Fatalf("cond[0]: %+v", cs[0])
	}
	if cs[1].Status != "False" || cs[1].Reason != "Err" {
		t.Fatalf("cond[1]: %+v", cs[1])
	}
}

func TestParseConditionsNoneWhenAbsent(t *testing.T) {
	if cs := ParseConditions(map[string]interface{}{}); len(cs) != 0 {
		t.Fatalf("want 0, got %d", len(cs))
	}
}

func TestToYAML(t *testing.T) {
	obj := map[string]interface{}{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Certificate",
		"metadata":   map[string]interface{}{"name": "web-tls", "namespace": "default"},
	}
	y, err := ToYAML(obj)
	if err != nil {
		t.Fatalf("ToYAML: %v", err)
	}
	if !strings.Contains(y, "kind: Certificate") || !strings.Contains(y, "name: web-tls") {
		t.Fatalf("yaml missing fields:\n%s", y)
	}
}

func TestToYAMLStripsManagedFields(t *testing.T) {
	obj := map[string]interface{}{
		"kind": "Certificate",
		"metadata": map[string]interface{}{
			"name":          "web-tls",
			"labels":        map[string]interface{}{"app": "web"},
			"managedFields": []interface{}{map[string]interface{}{"manager": "kustomize-controller"}},
		},
	}
	y, err := ToYAML(obj)
	if err != nil {
		t.Fatalf("ToYAML: %v", err)
	}
	if strings.Contains(y, "managedFields") || strings.Contains(y, "kustomize-controller") {
		t.Fatalf("managedFields should be stripped:\n%s", y)
	}
	if !strings.Contains(y, "name: web-tls") || !strings.Contains(y, "app: web") {
		t.Fatalf("real fields must survive:\n%s", y)
	}
	// Input must not be mutated.
	md := obj["metadata"].(map[string]interface{})
	if _, has := md["managedFields"]; !has {
		t.Fatal("ToYAML mutated the input map (removed managedFields)")
	}
}
