package fleet

import (
	"context"
	"fmt"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/moomora/klyx/internal/gitops/argo"
)

// ListArgoApps lists every Argo CD Application on the cluster, sorted
// diagnostically: broken apps (out of sync / unhealthy / unknown) first, then
// namespace/name. On-demand (no watch) - the Argo view is a triage surface,
// not a stream.
func (c *ClusterConn) ListArgoApps(ctx context.Context) ([]argo.App, error) {
	list, err := c.dyn.Resource(argo.AppGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list argo applications: %w", err)
	}
	out := make([]argo.App, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, argo.Parse(&list.Items[i]))
	}
	sort.SliceStable(out, func(a, b int) bool {
		ab, bb := out[a].Broken(), out[b].Broken()
		if ab != bb {
			return ab
		}
		if out[a].Namespace != out[b].Namespace {
			return out[a].Namespace < out[b].Namespace
		}
		return out[a].Name < out[b].Name
	})
	return out, nil
}

// RefreshArgoApp asks the controller to re-compare the app against its source
// (the argocd.argoproj.io/refresh annotation - Argo's reconcile trigger).
func (c *ClusterConn) RefreshArgoApp(ctx context.Context, namespace, name string) error {
	_, err := c.dyn.Resource(argo.AppGVR).Namespace(namespace).
		Patch(ctx, name, types.MergePatchType, argo.RefreshPatch(), metav1.PatchOptions{})
	return err
}

// SyncArgoApp starts a sync operation for the app at the given revision
// (""=HEAD). Prune is never set - that stays an explicit decision in Argo's
// own tooling.
func (c *ClusterConn) SyncArgoApp(ctx context.Context, namespace, name, revision string) error {
	_, err := c.dyn.Resource(argo.AppGVR).Namespace(namespace).
		Patch(ctx, name, types.MergePatchType, argo.SyncPatch(revision), metav1.PatchOptions{})
	return err
}
