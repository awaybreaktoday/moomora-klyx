package fleet

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

func gitRepoGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "gitrepositories"}
}

func seedGitRepo(name, url string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1",
		"kind":       "GitRepository",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{"url": url},
	}}
}

func TestSourceURLReturnsSpecURL(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{gitRepoGVR(): "GitRepositoryList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedGitRepo("flux-system", "https://gitlab.com/org/repo.git"))
	c := newActionConn(dyn)

	url, ok := c.SourceURL(context.Background(), "GitRepository", "flux-system", "flux-system")
	if !ok || url != "https://gitlab.com/org/repo.git" {
		t.Fatalf("want the seeded url, got %q ok=%v", url, ok)
	}
}

func TestSourceURLUnknownKind(t *testing.T) {
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), map[schema.GroupVersionResource]string{})
	c := newActionConn(dyn)
	if _, ok := c.SourceURL(context.Background(), "OCIRepository", "flux-system", "x"); ok {
		t.Fatal("unsupported source kind must return ok=false")
	}
}

func TestSourceURLNotFound(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{gitRepoGVR(): "GitRepositoryList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds)
	c := newActionConn(dyn)
	if _, ok := c.SourceURL(context.Background(), "GitRepository", "flux-system", "missing"); ok {
		t.Fatal("missing object must return ok=false")
	}
}
