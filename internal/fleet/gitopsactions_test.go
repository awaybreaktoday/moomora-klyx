package fleet

import (
	"context"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/gitops/flux"
)

func ksGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
}

func newActionConn(dyn *fake.FakeDynamicClient) *ClusterConn {
	typed := typedfake.NewSimpleClientset()
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{})
	c.ctx = context.Background()
	return c
}

func seedKustomization(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{},
	}}
}

func dynScheme() *runtime.Scheme {
	return runtime.NewScheme()
}

func TestReconcilePatchesAnnotation(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	c := newActionConn(dyn)

	if err := c.Reconcile(context.Background(), "Kustomization", "flux-system", "app"); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	var patched bool
	for _, a := range dyn.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && pa.GetName() == "app" {
			patched = true
			if !strings.Contains(string(pa.GetPatch()), flux.ReconcileRequestedAtAnnotation) {
				t.Fatalf("patch missing annotation: %s", pa.GetPatch())
			}
		}
	}
	if !patched {
		t.Fatal("expected a patch action on app")
	}
}

func TestSetSuspendPatchesSpec(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	c := newActionConn(dyn)

	if err := c.SetSuspend(context.Background(), "Kustomization", "flux-system", "app", true); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	found := false
	for _, a := range dyn.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && strings.Contains(string(pa.GetPatch()), `"suspend":true`) {
			found = true
		}
	}
	if !found {
		t.Fatal("expected a suspend:true patch")
	}
}

func TestReconcileUnknownKindErrors(t *testing.T) {
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), map[schema.GroupVersionResource]string{})
	c := newActionConn(dyn)
	if err := c.Reconcile(context.Background(), "Service", "default", "x"); err == nil {
		t.Fatal("want error for unsupported kind")
	}
}

func TestReconcileSurfacesForbidden(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	dyn.PrependReactor("patch", "kustomizations", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "kustomizations"}, "app", nil)
	})
	c := newActionConn(dyn)
	err := c.Reconcile(context.Background(), "Kustomization", "flux-system", "app")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "forbidden") {
		t.Fatalf("want forbidden error, got %v", err)
	}
}
