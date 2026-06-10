package fleet

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

// ksGVRSummary / hrGVRSummary are the GVRs used in the summary list path.
var (
	ksGVRSummary = schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	hrGVRSummary = schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}
)

func makeKS(name string, ready bool, suspended bool) *unstructured.Unstructured {
	readyStatus := "False"
	if ready {
		readyStatus = "True"
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{"suspend": suspended},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": readyStatus},
			},
		},
	}}
}

func makeHR(name string, ready bool, suspended bool) *unstructured.Unstructured {
	readyStatus := "False"
	if ready {
		readyStatus = "True"
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2",
		"kind":       "HelmRelease",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{"suspend": suspended},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": readyStatus},
			},
		},
	}}
}

// newSummaryConn builds a ClusterConn with a fake dynamic client pre-loaded with
// objects, and sets caps.GitOps.Flux.Present = fluxPresent directly.
func newSummaryConn(fluxPresent bool, objs ...runtime.Object) *ClusterConn {
	listKinds := map[schema.GroupVersionResource]string{
		ksGVRSummary: "KustomizationList",
		hrGVRSummary: "HelmReleaseList",
	}
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, objs...)
	typed := typedfake.NewSimpleClientset()
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{}, config.MetricsConfig{})
	c.mu.Lock()
	c.caps.GitOps.Flux.Present = fluxPresent
	c.mu.Unlock()
	return c
}

// TestGitOpsSummaryAbsent verifies that when Flux is not present we return
// {FluxPresent: false} without hitting the dynamic client.
func TestGitOpsSummaryAbsent(t *testing.T) {
	c := newSummaryConn(false)
	s, err := c.GitOpsSummary(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.FluxPresent || s.Total != 0 || s.NotReady != 0 || s.Suspended != 0 {
		t.Fatalf("want zero struct, got %+v", s)
	}
}

// TestGitOpsSummaryPresentCounts verifies: 1 ready KS + 1 not-ready HR + 1
// suspended KS → Total 3, NotReady 1, Suspended 1.
func TestGitOpsSummaryPresentCounts(t *testing.T) {
	c := newSummaryConn(true,
		makeKS("app", true, false),    // ready → contributes to Total only
		makeHR("infra", false, false), // not-ready, not suspended → NotReady++
		makeKS("paused", false, true), // suspended → Suspended++, not NotReady
	)
	s, err := c.GitOpsSummary(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !s.FluxPresent {
		t.Fatal("want FluxPresent=true")
	}
	if s.Total != 3 {
		t.Fatalf("want Total=3, got %d", s.Total)
	}
	if s.NotReady != 1 {
		t.Fatalf("want NotReady=1, got %d", s.NotReady)
	}
	if s.Suspended != 1 {
		t.Fatalf("want Suspended=1, got %d", s.Suspended)
	}
}

// TestGitOpsSummaryAllReady verifies a fully healthy cluster returns 0 for both
// NotReady and Suspended.
func TestGitOpsSummaryAllReady(t *testing.T) {
	c := newSummaryConn(true,
		makeKS("a", true, false),
		makeKS("b", true, false),
	)
	s, err := c.GitOpsSummary(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.Total != 2 || s.NotReady != 0 || s.Suspended != 0 {
		t.Fatalf("want Total=2, NotReady=0, Suspended=0, got %+v", s)
	}
}
