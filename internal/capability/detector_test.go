package capability

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	discoveryfake "k8s.io/client-go/discovery/fake"
)

func newFake(groups []*metav1.APIResourceList, objs ...runtime.Object) *fake.Clientset {
	cs := fake.NewSimpleClientset(objs...)
	cs.Discovery().(*discoveryfake.FakeDiscovery).Resources = groups
	return cs
}

func fluxControllerDeploy(name string, ready int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "flux-system"},
		Status:     appsv1.DeploymentStatus{AvailableReplicas: ready},
		Spec:       appsv1.DeploymentSpec{Replicas: ptr(int32(1))},
	}
}

func ptr[T any](v T) *T { return &v }

func TestDetectFluxAbsent(t *testing.T) {
	cs := newFake(nil)
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Absent {
		t.Fatalf("want Absent, got %v", set.GitOps.Tier)
	}
}

func TestDetectFluxPresentButUnhealthy(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "kustomize.toolkit.fluxcd.io/v1"}}
	cs := newFake(groups, fluxControllerDeploy("kustomize-controller", 0))
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Degraded {
		t.Fatalf("want Degraded, got %v (%s)", set.GitOps.Tier, set.GitOps.Reason)
	}
	if set.GitOps.Reason == "" {
		t.Fatal("expected a reason for degraded flux")
	}
}

func TestDetectFluxHealthy(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "kustomize.toolkit.fluxcd.io/v1"}}
	cs := newFake(groups, fluxControllerDeploy("kustomize-controller", 1))
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Healthy {
		t.Fatalf("want Healthy, got %v", set.GitOps.Tier)
	}
	if !set.GitOps.Flux.Present || !set.GitOps.Flux.Healthy {
		t.Fatalf("want flux present+healthy, got %+v", set.GitOps.Flux)
	}
}

func TestDetectGatewayPresentWithoutEnvoyProxyIsDegraded(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "gateway.networking.k8s.io/v1"}}
	cs := newFake(groups)
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.Network.Tier != Degraded {
		t.Fatalf("want Degraded (no EnvoyProxy), got %v", set.Network.Tier)
	}
	if set.Network.GatewayAPIVersion != "v1" {
		t.Fatalf("want pinned version v1, got %q", set.Network.GatewayAPIVersion)
	}
}
