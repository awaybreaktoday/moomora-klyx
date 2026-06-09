package fleet

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/crd"
)

func TestGetInstanceDetailEventsErrorDegrades(t *testing.T) {
	wGVR := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{wGVR: "WidgetList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "example.com/v1", "kind": "Widget",
		"metadata": map[string]interface{}{"name": "w1", "namespace": "team-a", "uid": "uid-1"},
		"status":   map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}}},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	typed := typedfake.NewSimpleClientset()
	typed.PrependReactor("list", "events", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "events"}, "", nil)
	})
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

	d, err := c.GetInstanceDetail(context.Background(), "example.com", "v1", "widgets", "team-a", "w1")
	if err != nil {
		t.Fatalf("an events error must not fail the detail: %v", err)
	}
	if !strings.Contains(d.YAML, "kind: Widget") || len(d.Conditions) != 1 {
		t.Fatalf("yaml/conditions must survive an events error: %+v", d)
	}
	if len(d.Events) != 0 {
		t.Fatalf("want no events on error, got %d", len(d.Events))
	}
}

func TestGetInstanceDetailNoUIDSkipsEvents(t *testing.T) {
	wGVR := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{wGVR: "WidgetList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "example.com/v1", "kind": "Widget",
		"metadata": map[string]interface{}{"name": "w1", "namespace": "team-a"}, // no uid
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	// Seed an unrelated event; the fake does not apply the uid field selector, so
	// without the empty-uid guard this would leak into the result.
	ev := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "x.evt", Namespace: "team-a"}, Type: "Normal", Reason: "X"}
	typed := typedfake.NewSimpleClientset(ev)
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

	d, err := c.GetInstanceDetail(context.Background(), "example.com", "v1", "widgets", "team-a", "w1")
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if len(d.Events) != 0 {
		t.Fatalf("a uid-less object must skip the event list, got %d events", len(d.Events))
	}
}

func crdUnstructured(group, kind, plural, scope string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   map[string]interface{}{"name": plural + "." + group},
		"spec": map[string]interface{}{
			"group":    group,
			"names":    map[string]interface{}{"kind": kind, "plural": plural},
			"scope":    scope,
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
	c := NewClusterConn("x", nil, nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

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
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{}, config.MetricsConfig{})

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
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{}, config.MetricsConfig{})

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
		LastTimestamp: metav1.Now(),
	}
	typed := typedfake.NewSimpleClientset(ev)

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

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
	c := NewClusterConn("x", typedfake.NewSimpleClientset(), nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

	d, err := c.GetInstanceDetail(context.Background(), "cilium.io", "v2", "ciliumnodes", "", "node-1")
	if err != nil {
		t.Fatalf("cluster-scoped detail: %v", err)
	}
	if d.Kind != "CiliumNode" || d.Namespace != "" || !strings.Contains(d.YAML, "kind: CiliumNode") {
		t.Fatalf("cluster-scoped: %+v", d)
	}
}

func TestGetInstanceDetailSecretMasked(t *testing.T) {
	secretGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{secretGVR: "SecretList"}

	b64pass := "aHVudGVyMg==" // base64("hunter2")
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]interface{}{"name": "app-secret", "namespace": "default", "uid": "uid-s1"},
		"data": map[string]interface{}{
			"password": b64pass,
		},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	typed := typedfake.NewSimpleClientset()
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

	d, err := c.GetInstanceDetail(context.Background(), "", "v1", "secrets", "default", "app-secret")
	if err != nil {
		t.Fatalf("detail: %v", err)
	}

	// YAML must contain the key name but not the base64 value.
	if !strings.Contains(d.YAML, "password") {
		t.Fatalf("key name missing from YAML:\n%s", d.YAML)
	}
	if strings.Contains(d.YAML, b64pass) {
		t.Fatalf("base64 value must be masked in YAML:\n%s", d.YAML)
	}
	if !strings.Contains(d.YAML, "<masked>") {
		t.Fatalf("<masked> placeholder missing from YAML:\n%s", d.YAML)
	}

	// SecretKeys must list the key with correct byte length.
	if len(d.SecretKeys) != 1 || d.SecretKeys[0].Key != "password" || d.SecretKeys[0].Bytes != 7 {
		t.Fatalf("SecretKeys: %+v", d.SecretKeys)
	}
}

func TestGetInstanceDetailNonSecretUnaffected(t *testing.T) {
	wGVR := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{wGVR: "WidgetList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata":   map[string]interface{}{"name": "w1", "namespace": "team-a", "uid": "uid-w1"},
		"spec":       map[string]interface{}{"field": "visible-value"},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	c := NewClusterConn("x", typedfake.NewSimpleClientset(), nil, dyn, nil, clock.Real{}, config.MetricsConfig{})

	d, err := c.GetInstanceDetail(context.Background(), "example.com", "v1", "widgets", "team-a", "w1")
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if !strings.Contains(d.YAML, "visible-value") {
		t.Fatalf("non-secret field must not be masked:\n%s", d.YAML)
	}
	if len(d.SecretKeys) != 0 {
		t.Fatalf("SecretKeys must be empty for non-secret, got %+v", d.SecretKeys)
	}
}

func TestRevealSecretKey(t *testing.T) {
	// client-go typed fake stores Secret.Data as []byte; the Secret.Data field
	// is decoded bytes, not base64.
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "app-secret", Namespace: "default"},
		Data:       map[string][]byte{"password": []byte("hunter2"), "token": []byte("abc")},
	}
	typed := typedfake.NewSimpleClientset(sec)
	c := NewClusterConn("x", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})

	val, err := c.RevealSecretKey(context.Background(), "default", "app-secret", "password")
	if err != nil {
		t.Fatalf("reveal: %v", err)
	}
	if val != "hunter2" {
		t.Fatalf("want 'hunter2', got %q", val)
	}
}

func TestRevealSecretKeyMissingKey(t *testing.T) {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "app-secret", Namespace: "default"},
		Data:       map[string][]byte{"token": []byte("abc")},
	}
	typed := typedfake.NewSimpleClientset(sec)
	c := NewClusterConn("x", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})

	_, err := c.RevealSecretKey(context.Background(), "default", "app-secret", "nonexistent")
	if err == nil {
		t.Fatal("want error for missing key, got nil")
	}
}

func TestRevealSecretKeyMissingSecret(t *testing.T) {
	typed := typedfake.NewSimpleClientset()
	c := NewClusterConn("x", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})

	_, err := c.RevealSecretKey(context.Background(), "default", "ghost-secret", "key")
	if err == nil {
		t.Fatal("want error for missing secret, got nil")
	}
}

func partialMeta(group, version, kind, ns, name string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: group + "/" + version, Kind: kind},
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
	}
}
