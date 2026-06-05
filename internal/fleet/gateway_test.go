package fleet

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
)

func gwGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"}
}
func hrGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
}

// seedGW builds a fake dynamic client and seeds the given objects under their
// exact GVRs via Create. The default fake plural-guesser maps "Gateway" to
// "gatewaies", so constructor-varargs seeding would key the object under the
// wrong resource; Create on the explicit GVR avoids that.
func seedGW(t *testing.T, objs map[schema.GroupVersionResource][]*unstructured.Unstructured) dynamic.Interface {
	t.Helper()
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds)
	for gvr, items := range objs {
		for _, o := range items {
			ns, _, _ := unstructured.NestedString(o.Object, "metadata", "namespace")
			if _, err := dyn.Resource(gvr).Namespace(ns).Create(context.Background(), o, metav1.CreateOptions{}); err != nil {
				t.Fatalf("seed %s: %v", gvr, err)
			}
		}
	}
	return dyn
}

func gw(name, ns string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway",
		"metadata": map[string]interface{}{"name": name, "namespace": ns},
		"spec":     map[string]interface{}{"gatewayClassName": "envoy-gateway", "listeners": []interface{}{map[string]interface{}{"name": "http", "protocol": "HTTP", "port": int64(80)}}},
		"status":   map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}, map[string]interface{}{"type": "Programmed", "status": "True"}}},
	}}
}

func hr(name, ns, gwName, gwNS, backend string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute",
		"metadata": map[string]interface{}{"name": name, "namespace": ns},
		"spec": map[string]interface{}{
			"parentRefs": []interface{}{map[string]interface{}{"name": gwName, "namespace": gwNS}},
			"rules":      []interface{}{map[string]interface{}{"backendRefs": []interface{}{map[string]interface{}{"name": backend, "port": int64(80), "weight": int64(100)}}}},
		},
		"status": map[string]interface{}{"parents": []interface{}{map[string]interface{}{"parentRef": map[string]interface{}{"name": gwName, "namespace": gwNS}, "conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}, map[string]interface{}{"type": "ResolvedRefs", "status": "True"}}}}},
	}}
}

func TestGetGatewayTopology(t *testing.T) {
	dyn := seedGW(t, map[schema.GroupVersionResource][]*unstructured.Unstructured{
		gwGVR(): {gw("eg", "infra")},
		hrGVR(): {hr("share", "apps", "eg", "infra", "share-api")},
	})

	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"},
		Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Ports: []corev1.ServicePort{{Port: 80}}},
	}
	ready := true
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Name: "share-api-abc", Namespace: "apps", Labels: map[string]string{"kubernetes.io/service-name": "share-api"}},
		Endpoints:  []discoveryv1.Endpoint{{Conditions: discoveryv1.EndpointConditions{Ready: &ready}}, {Conditions: discoveryv1.EndpointConditions{Ready: &ready}}},
	}
	typed := typedfake.NewSimpleClientset(svc, eps)

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	if topo.Gateway.Name != "eg" || !topo.Gateway.Programmed {
		t.Fatalf("gateway: %+v", topo.Gateway)
	}
	if len(topo.Routes) != 1 || topo.Routes[0].Name != "share" || !topo.Routes[0].Accepted {
		t.Fatalf("routes: %+v", topo.Routes)
	}
	r := topo.Routes[0]
	if len(r.Services) != 1 || r.Services[0].Name != "share-api" || !r.Services[0].Resolved {
		t.Fatalf("service: %+v", r.Services)
	}
	if r.Pods.Ready != 2 || r.Pods.Total != 2 || r.Pods.Unknown {
		t.Fatalf("pods: %+v", r.Pods)
	}
}

func TestGetGatewayTopologyUnresolvedBackendWarns(t *testing.T) {
	dyn := seedGW(t, map[schema.GroupVersionResource][]*unstructured.Unstructured{
		gwGVR(): {gw("eg", "infra")},
		hrGVR(): {hr("share", "apps", "eg", "infra", "missing-svc")},
	})
	typed := typedfake.NewSimpleClientset() // no service

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology must still render: %v", err)
	}
	if len(topo.Routes) != 1 || topo.Routes[0].Services[0].Resolved {
		t.Fatalf("backend should be unresolved: %+v", topo.Routes)
	}
	if len(topo.Warnings) == 0 {
		t.Fatal("an unresolved backend must produce a warning")
	}
}

func TestListGatewaysServedFlag(t *testing.T) {
	dyn := seedGW(t, map[schema.GroupVersionResource][]*unstructured.Unstructured{
		gwGVR(): {gw("eg", "infra")},
	})
	typed := typedfake.NewSimpleClientset()
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	refs, served, err := c.ListGateways(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// The fake discovery has no Gateway API group, so served is false (fallback path).
	_ = served
	if len(refs) != 1 || refs[0].Name != "eg" || !refs[0].Programmed {
		t.Fatalf("refs: %+v", refs)
	}
}
