package crd

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func boolPtr(b bool) *bool { return &b }

func makeService(name, ns string, ports []corev1.ServicePort, selector map[string]string) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       corev1.ServiceSpec{Ports: ports, Selector: selector},
	}
}

func makeSlice(name, ns string, endpoints []discoveryv1.Endpoint) discoveryv1.EndpointSlice {
	return discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Endpoints:  endpoints,
	}
}

func makeEndpoint(ip string, ready *bool, targetKind, targetName string) discoveryv1.Endpoint {
	ep := discoveryv1.Endpoint{
		Addresses:  []string{ip},
		Conditions: discoveryv1.EndpointConditions{Ready: ready},
	}
	if targetKind != "" || targetName != "" {
		ep.TargetRef = &corev1.ObjectReference{Kind: targetKind, Name: targetName}
	}
	return ep
}

func TestBuildServiceBackingReadyCounts(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	slices := []discoveryv1.EndpointSlice{
		makeSlice("web-abc", "default", []discoveryv1.Endpoint{
			makeEndpoint("10.0.0.1", boolPtr(true), "Pod", "web-pod-1"),
			makeEndpoint("10.0.0.2", boolPtr(false), "Pod", "web-pod-2"),
		}),
		makeSlice("web-def", "default", []discoveryv1.Endpoint{
			makeEndpoint("10.0.0.3", boolPtr(true), "Pod", "web-pod-3"),
		}),
	}
	b := BuildServiceBacking(svc, slices)
	if b.Ready != 2 {
		t.Fatalf("want Ready=2, got %d", b.Ready)
	}
	if b.NotReady != 1 {
		t.Fatalf("want NotReady=1, got %d", b.NotReady)
	}
}

// TestBuildServiceBackingNilReadyMeansReady verifies the EndpointSlice API
// convention: a nil Conditions.Ready pointer means ready.
func TestBuildServiceBackingNilReadyMeansReady(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	slices := []discoveryv1.EndpointSlice{
		makeSlice("web-abc", "default", []discoveryv1.Endpoint{
			makeEndpoint("10.0.0.1", nil, "Pod", "web-pod-1"), // nil = ready
			makeEndpoint("10.0.0.2", boolPtr(false), "Pod", "web-pod-2"),
		}),
	}
	b := BuildServiceBacking(svc, slices)
	if b.Ready != 1 {
		t.Fatalf("nil Ready must count as ready; want Ready=1, got %d", b.Ready)
	}
	if b.NotReady != 1 {
		t.Fatalf("want NotReady=1, got %d", b.NotReady)
	}
}

func TestBuildServiceBackingReadyFirst(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	slices := []discoveryv1.EndpointSlice{
		makeSlice("web-abc", "default", []discoveryv1.Endpoint{
			makeEndpoint("10.0.0.5", boolPtr(false), "Pod", "bad"),
			makeEndpoint("10.0.0.1", boolPtr(true), "Pod", "good"),
		}),
	}
	b := BuildServiceBacking(svc, slices)
	if len(b.Addresses) != 2 {
		t.Fatalf("want 2 addresses, got %d", len(b.Addresses))
	}
	if !b.Addresses[0].Ready {
		t.Fatalf("first address must be ready; got %+v", b.Addresses[0])
	}
	if b.Addresses[1].Ready {
		t.Fatalf("second address must be not-ready; got %+v", b.Addresses[1])
	}
}

func TestBuildServiceBackingCapAt50(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	eps := make([]discoveryv1.Endpoint, 60)
	for i := range eps {
		ip := "10.0.0." + string(rune('0'+i%10))
		eps[i] = makeEndpoint(ip, boolPtr(true), "Pod", "pod")
	}
	slices := []discoveryv1.EndpointSlice{makeSlice("s", "default", eps)}
	b := BuildServiceBacking(svc, slices)
	if len(b.Addresses) != maxEndpointAddrs {
		t.Fatalf("want %d addresses (cap), got %d", maxEndpointAddrs, len(b.Addresses))
	}
	if b.Ready != 60 {
		t.Fatalf("Ready count must reflect all 60, not the cap; got %d", b.Ready)
	}
}

func TestBuildServiceBackingPorts(t *testing.T) {
	ports := []corev1.ServicePort{
		{Name: "http", Port: 80, Protocol: corev1.ProtocolTCP},
		{Name: "metrics", Port: 9090, Protocol: corev1.ProtocolTCP},
	}
	svc := makeService("web", "default", ports, nil)
	b := BuildServiceBacking(svc, nil)
	if len(b.Ports) != 2 {
		t.Fatalf("want 2 ports, got %d", len(b.Ports))
	}
	if b.Ports[0].Name != "http" || b.Ports[0].Port != 80 || b.Ports[0].Protocol != "TCP" {
		t.Fatalf("port[0]: %+v", b.Ports[0])
	}
}

func TestBuildServiceBackingSelector(t *testing.T) {
	sel := map[string]string{"app": "web", "env": "prod"}
	svc := makeService("web", "default", nil, sel)
	b := BuildServiceBacking(svc, nil)
	if b.Selector["app"] != "web" || b.Selector["env"] != "prod" {
		t.Fatalf("selector: %+v", b.Selector)
	}
}

func TestBuildServiceBackingTargetRef(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	slices := []discoveryv1.EndpointSlice{
		makeSlice("web-abc", "default", []discoveryv1.Endpoint{
			makeEndpoint("10.0.0.1", boolPtr(true), "Pod", "web-pod-1"),
		}),
	}
	b := BuildServiceBacking(svc, slices)
	if len(b.Addresses) != 1 {
		t.Fatalf("want 1 address, got %d", len(b.Addresses))
	}
	if b.Addresses[0].TargetKind != "Pod" || b.Addresses[0].TargetName != "web-pod-1" {
		t.Fatalf("TargetRef: %+v", b.Addresses[0])
	}
}

func TestBuildServiceBackingEmptySlices(t *testing.T) {
	svc := makeService("web", "default", nil, nil)
	b := BuildServiceBacking(svc, nil)
	if b.Ready != 0 || b.NotReady != 0 || len(b.Addresses) != 0 {
		t.Fatalf("empty slices: %+v", b)
	}
}
