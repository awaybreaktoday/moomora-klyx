package fleet

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/gitops/flux"
)

func ksObj(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"status": map[string]interface{}{
			"conditions":          []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
			"lastAppliedRevision": "main@sha1:abc",
		},
	}}
}

func gitRepoUnstructured(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1",
		"kind":       "GitRepository",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{"url": "https://github.com/org/repo"},
		"status": map[string]interface{}{
			"artifact":   map[string]interface{}{"revision": "main@sha1:def"},
			"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
		},
	}}
}

func sourceGVRToListKinds() map[schema.GroupVersionResource]string {
	return map[schema.GroupVersionResource]string{
		{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}:    "KustomizationList",
		{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}:           "HelmReleaseList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "gitrepositories"}:      "GitRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1beta2", Resource: "ocirepositories"}: "OCIRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "buckets"}:              "BucketList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "helmrepositories"}:     "HelmRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "helmcharts"}:           "HelmChartList",
	}
}

func TestGitOpsSourcesReturnsWatchedSources(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, sourceGVRToListKinds(), gitRepoUnstructured("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{}, config.MetricsConfig{})
	c.ctx = ctx

	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		return len(c.GitOpsSources()) == 1
	})
	srcs := c.GitOpsSources()
	if srcs[0].Kind != flux.GitRepositoryKind || srcs[0].Revision != "main@sha1:def" {
		t.Fatalf("source: %+v", srcs[0])
	}
	if _, ok := c.GitOpsSourceObject("GitRepository", "flux-system", "flux-system"); !ok {
		t.Fatal("expected GitOpsSourceObject to find the watched GitRepository")
	}
	if _, ok := c.GitOpsSourceObject("GitRepository", "flux-system", "nope"); ok {
		t.Fatal("did not expect to find a nonexistent source")
	}
}

func TestOpenGitOpsListsKustomizations(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()

	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, sourceGVRToListKinds(), ksObj("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{}, config.MetricsConfig{})
	c.ctx = ctx

	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		rs := c.GitOpsResources()
		return len(rs) == 1 && rs[0].Kind == flux.KustomizationKind && rs[0].Ready == flux.Ready
	})
}

func TestGitOpsObjectReturnsWatchedObject(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, sourceGVRToListKinds(), ksObj("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{}, config.MetricsConfig{})
	c.ctx = ctx
	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		_, ok := c.GitOpsObject("Kustomization", "flux-system", "flux-system")
		return ok
	})
	if _, ok := c.GitOpsObject("Kustomization", "flux-system", "nope"); ok {
		t.Fatal("did not expect to find a nonexistent object")
	}
}

func TestGitOpsResourcesAreStablySorted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()
	scheme := runtime.NewScheme()
	// Seed out of alphabetical order; GitOpsResources must return them sorted.
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, sourceGVRToListKinds(),
		ksObj("z-app"), ksObj("a-app"), ksObj("m-app"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{}, config.MetricsConfig{})
	c.ctx = ctx
	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool { return len(c.GitOpsResources()) == 3 })

	rs := c.GitOpsResources()
	if rs[0].Name != "a-app" || rs[1].Name != "m-app" || rs[2].Name != "z-app" {
		t.Fatalf("want a-app,m-app,z-app order, got %s,%s,%s", rs[0].Name, rs[1].Name, rs[2].Name)
	}
}
