package fleet

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/crd"
)

func crdUnstructured(group, kind, plural, scope string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   map[string]interface{}{"name": plural + "." + group},
		"spec": map[string]interface{}{
			"group": group,
			"names": map[string]interface{}{"kind": kind, "plural": plural},
			"scope": scope,
			"versions": []interface{}{map[string]interface{}{"name": "v1", "served": true, "storage": true}},
		},
	}}
}

func TestListCRDs(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{crd.GVR: "CustomResourceDefinitionList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds,
		crdUnstructured("cilium.io", "CiliumEndpoint", "ciliumendpoints", "Namespaced"),
		crdUnstructured("cert-manager.io", "Certificate", "certificates", "Namespaced"),
	)
	c := NewClusterConn("x", nil, nil, dyn, nil, clock.Real{})

	infos, err := c.ListCRDs(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(infos) != 2 {
		t.Fatalf("want 2 CRDs, got %d", len(infos))
	}
	byKind := map[string]crd.Info{}
	for _, i := range infos {
		byKind[i.Kind] = i
	}
	if byKind["CiliumEndpoint"].Plural != "ciliumendpoints" || byKind["CiliumEndpoint"].Version != "v1" {
		t.Fatalf("cilium: %+v", byKind["CiliumEndpoint"])
	}
}

func TestCountResourceUncapped(t *testing.T) {
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	mc := metadatafake.NewSimpleMetadataClient(scheme,
		partialMeta("example.com", "v1", "Widget", "a", "w1"),
		partialMeta("example.com", "v1", "Widget", "b", "w2"),
		partialMeta("example.com", "v1", "Widget", "b", "w3"),
	)
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{})

	n, capped, err := c.CountResource(context.Background(), "example.com", "v1", "widgets")
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 || capped {
		t.Fatalf("want 3 uncapped, got %d capped=%v", n, capped)
	}
}

func TestListInstances(t *testing.T) {
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	mc := metadatafake.NewSimpleMetadataClient(scheme,
		partialMeta("example.com", "v1", "Widget", "team-a", "w1"),
		partialMeta("example.com", "v1", "Widget", "team-b", "w2"),
	)
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{})

	items, next, err := c.ListInstances(context.Background(), "example.com", "v1", "widgets", 100, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 instances, got %d", len(items))
	}
	byName := map[string]crd.InstanceMeta{}
	for _, m := range items {
		byName[m.Name] = m
	}
	if byName["w1"].Namespace != "team-a" {
		t.Fatalf("w1 namespace: %q", byName["w1"].Namespace)
	}
	if next != "" {
		t.Fatalf("fake should report no continue token, got %q", next)
	}
}

func TestGetInstanceDetail(t *testing.T) {
	wGVR := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{wGVR: "WidgetList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata":   map[string]interface{}{"name": "w1", "namespace": "team-a", "uid": "uid-1", "labels": map[string]interface{}{"app": "w"}},
		"status":     map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True", "reason": "OK", "message": "ready"}}},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)

	ev := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "w1.evt", Namespace: "team-a"},
		InvolvedObject: corev1.ObjectReference{Kind: "Widget", Name: "w1", Namespace: "team-a", UID: "uid-1"},
		Type:           "Warning", Reason: "Failed", Message: "could not reconcile", Count: 3,
		LastTimestamp:  metav1.Now(),
	}
	typed := typedfake.NewSimpleClientset(ev)

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	d, err := c.GetInstanceDetail(context.Background(), "example.com", "v1", "widgets", "team-a", "w1")
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if d.Kind != "Widget" || d.Name != "w1" || d.Namespace != "team-a" {
		t.Fatalf("header: %+v", d)
	}
	if len(d.Conditions) != 1 || d.Conditions[0].Type != "Ready" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if len(d.Events) != 1 || d.Events[0].Type != "Warning" || d.Events[0].Count != 3 {
		t.Fatalf("events: %+v", d.Events)
	}
	if !strings.Contains(d.YAML, "kind: Widget") {
		t.Fatalf("yaml: %s", d.YAML)
	}
	if d.Labels["app"] != "w" {
		t.Fatalf("labels: %+v", d.Labels)
	}
}

func TestGetInstanceDetailClusterScoped(t *testing.T) {
	nGVR := schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumnodes"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{nGVR: "CiliumNodeList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "cilium.io/v2",
		"kind":       "CiliumNode",
		"metadata":   map[string]interface{}{"name": "node-1", "uid": "uid-n1"},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	c := NewClusterConn("x", typedfake.NewSimpleClientset(), nil, dyn, nil, clock.Real{})

	d, err := c.GetInstanceDetail(context.Background(), "cilium.io", "v2", "ciliumnodes", "", "node-1")
	if err != nil {
		t.Fatalf("cluster-scoped detail: %v", err)
	}
	if d.Kind != "CiliumNode" || d.Namespace != "" || !strings.Contains(d.YAML, "kind: CiliumNode") {
		t.Fatalf("cluster-scoped: %+v", d)
	}
}

func partialMeta(group, version, kind, ns, name string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: group + "/" + version, Kind: kind},
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
	}
}
