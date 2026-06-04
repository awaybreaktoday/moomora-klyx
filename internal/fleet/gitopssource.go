package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// sourceGVR maps a Flux source kind to its group, fallback version, and resource.
// Only GitRepository is supported; OCIRepository/Bucket are future work.
func sourceGVR(kind string) (group, fallbackVersion, resource string, ok bool) {
	switch kind {
	case "GitRepository":
		return "source.toolkit.fluxcd.io", "v1", "gitrepositories", true
	default:
		return "", "", "", false
	}
}

// SourceURL fetches spec.url from a Flux source object via a one-off dynamic Get
// (the source is not watched). Returns ok=false for an unsupported kind, a Get
// error, or an empty url.
func (c *ClusterConn) SourceURL(ctx context.Context, kind, ns, name string) (string, bool) {
	group, fallback, resource, ok := sourceGVR(kind)
	if !ok {
		return "", false
	}
	version := preferredVersion(c.typed.Discovery(), group, fallback)
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: resource}
	u, err := c.dyn.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", false
	}
	url, _, _ := unstructured.NestedString(u.Object, "spec", "url")
	if url == "" {
		return "", false
	}
	return url, true
}
