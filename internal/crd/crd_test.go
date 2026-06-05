package crd

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func crdObj(group, kind, plural, scope string, shortNames []string, versions []interface{}, labels map[string]interface{}) *unstructured.Unstructured {
	sn := make([]interface{}, len(shortNames))
	for i, s := range shortNames {
		sn[i] = s
	}
	meta := map[string]interface{}{"name": plural + "." + group}
	if labels != nil {
		meta["labels"] = labels
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   meta,
		"spec": map[string]interface{}{
			"group":    group,
			"names":    map[string]interface{}{"kind": kind, "plural": plural, "shortNames": sn},
			"scope":    scope,
			"versions": versions,
		},
	}}
}

func TestParseCRDNamespacedWithShortNames(t *testing.T) {
	u := crdObj("cilium.io", "CiliumEndpoint", "ciliumendpoints", "Namespaced",
		[]string{"cep", "ciliumep"},
		[]interface{}{map[string]interface{}{"name": "v2", "served": true, "storage": true}},
		map[string]interface{}{"app.kubernetes.io/part-of": "cilium"})
	got, ok := ParseCRD(u)
	if !ok {
		t.Fatal("want ok")
	}
	if got.Group != "cilium.io" || got.Kind != "CiliumEndpoint" || got.Plural != "ciliumendpoints" {
		t.Fatalf("ids: %+v", got)
	}
	if got.Scope != "Namespaced" || got.Version != "v2" {
		t.Fatalf("scope/version: %+v", got)
	}
	if len(got.ShortNames) != 2 || got.ShortNames[0] != "cep" {
		t.Fatalf("shortNames: %+v", got.ShortNames)
	}
	if got.Operator != "cilium" {
		t.Fatalf("operator: %q", got.Operator)
	}
}

func TestParseCRDStorageVersionPick(t *testing.T) {
	u := crdObj("example.com", "Widget", "widgets", "Cluster", nil, []interface{}{
		map[string]interface{}{"name": "v1beta1", "served": true, "storage": false},
		map[string]interface{}{"name": "v1", "served": true, "storage": true},
	}, nil)
	got, ok := ParseCRD(u)
	if !ok || got.Version != "v1" || got.Scope != "Cluster" {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestParseCRDServedFallbackWhenNoStorage(t *testing.T) {
	u := crdObj("example.com", "Widget", "widgets", "Namespaced", nil, []interface{}{
		map[string]interface{}{"name": "v1alpha1", "served": true, "storage": false},
	}, nil)
	if got, _ := ParseCRD(u); got.Version != "v1alpha1" {
		t.Fatalf("want served fallback v1alpha1, got %q", got.Version)
	}
}

func TestParseCRDRejectsMissingNames(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"spec": map[string]interface{}{"group": "example.com"},
	}}
	if _, ok := ParseCRD(u); ok {
		t.Fatal("want ok=false for missing kind/plural")
	}
}

func TestCountDisplay(t *testing.T) {
	if n, capped := CountDisplay(3, ""); n != 3 || capped {
		t.Fatalf("uncapped: %d %v", n, capped)
	}
	if n, capped := CountDisplay(Cap, "more"); n != Cap || !capped {
		t.Fatalf("capped: %d %v", n, capped)
	}
}
