package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/crd"
)

// ListCRDs lists the cluster's CustomResourceDefinitions and parses them. A
// single cheap dynamic list; no watch.
func (c *ClusterConn) ListCRDs(ctx context.Context) ([]crd.Info, error) {
	list, err := c.dyn.Resource(crd.GVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]crd.Info, 0, len(list.Items))
	for i := range list.Items {
		u := &unstructured.Unstructured{Object: list.Items[i].Object}
		if info, ok := crd.ParseCRD(u); ok {
			out = append(out, info)
		}
	}
	return out, nil
}

// CountResource returns a hybrid instance count for a kind via a single
// metadata-only list page (Limit=crd.Cap). count is exact below the cap; at the
// cap with a continue token it is the cap and capped=true.
func (c *ClusterConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: crd.Cap})
	if err != nil {
		return 0, false, err
	}
	count, capped := crd.CountDisplay(len(list.Items), list.GetContinue())
	return count, capped, nil
}

// ListInstances returns one metadata-only page of instances of a kind plus the
// next continue token ("" on the last page). A single list page; no watch.
func (c *ClusterConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: limit, Continue: continueToken})
	if err != nil {
		return nil, "", err
	}
	out := make([]crd.InstanceMeta, 0, len(list.Items))
	for i := range list.Items {
		m := &list.Items[i]
		out = append(out, crd.InstanceMeta{
			Namespace: m.GetNamespace(),
			Name:      m.GetName(),
			Created:   m.GetCreationTimestamp().Time,
		})
	}
	return out, list.GetContinue(), nil
}
