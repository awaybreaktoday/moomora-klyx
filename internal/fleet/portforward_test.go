package fleet

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func ready(b bool) *bool { return &b }

// connWith builds a ClusterConn over a fake typed clientset seeded with objects.
// This exercises ResolveServicePod, the only fake-testable seam: PortForward
// itself needs a live SPDY transport and is covered by native verification.
func connWith(objs ...runtime.Object) *ClusterConn {
	typed := fake.NewSimpleClientset(objs...)
	return NewClusterConn("c", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
}

func TestResolveServicePod_NumericTargetPort(t *testing.T) {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api"},
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{
				{Name: "http", Port: 80, TargetPort: intstr.FromInt32(8080)},
			},
		},
	}
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
		Endpoints: []discoveryv1.Endpoint{
			{Conditions: discoveryv1.EndpointConditions{Ready: ready(true)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "api-7d4-xyz"}},
		},
	}
	c := connWith(svc, eps)

	pod, tp, err := c.ResolveServicePod(context.Background(), "team", "api", 80)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pod != "api-7d4-xyz" {
		t.Fatalf("pod = %q, want api-7d4-xyz", pod)
	}
	if tp != 8080 {
		t.Fatalf("targetPort = %d, want 8080", tp)
	}
}

func TestResolveServicePod_NamedTargetPort(t *testing.T) {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api"},
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{
				{Name: "http", Port: 80, TargetPort: intstr.FromString("web")},
			},
		},
	}
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
		Endpoints: []discoveryv1.Endpoint{
			{Conditions: discoveryv1.EndpointConditions{Ready: ready(true)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "api-pod"}},
		},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-pod"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{Name: "app", Ports: []corev1.ContainerPort{{Name: "web", ContainerPort: 9090}}},
			},
		},
	}
	c := connWith(svc, eps, pod)

	gotPod, tp, err := c.ResolveServicePod(context.Background(), "team", "api", 80)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPod != "api-pod" {
		t.Fatalf("pod = %q, want api-pod", gotPod)
	}
	if tp != 9090 {
		t.Fatalf("targetPort = %d, want 9090 (named port resolved from container)", tp)
	}
}

func TestResolveServicePod_NoReadyEndpoints(t *testing.T) {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api"},
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{{Name: "http", Port: 80, TargetPort: intstr.FromInt32(8080)}},
		},
	}
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
		Endpoints: []discoveryv1.Endpoint{
			// Not ready: must be skipped, leaving no usable endpoint.
			{Conditions: discoveryv1.EndpointConditions{Ready: ready(false)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "api-down"}},
		},
	}
	c := connWith(svc, eps)

	_, _, err := c.ResolveServicePod(context.Background(), "team", "api", 80)
	if err == nil {
		t.Fatal("want error for no ready endpoints, got nil")
	}
	if !strings.Contains(err.Error(), "no ready endpoints") {
		t.Fatalf("error = %q, want 'no ready endpoints'", err.Error())
	}
}

func TestResolveServicePod_NamedPortNotFound(t *testing.T) {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api"},
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{{Name: "http", Port: 80, TargetPort: intstr.FromString("missing")}},
		},
	}
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
		Endpoints: []discoveryv1.Endpoint{
			{Conditions: discoveryv1.EndpointConditions{Ready: ready(true)}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "api-pod"}},
		},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-pod"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Ports: []corev1.ContainerPort{{Name: "web", ContainerPort: 9090}}}}},
	}
	c := connWith(svc, eps, pod)

	_, _, err := c.ResolveServicePod(context.Background(), "team", "api", 80)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want named-port-not-found error, got %v", err)
	}
}
