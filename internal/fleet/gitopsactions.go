package fleet

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// fluxGroupForKind returns the API group + fallback preferred version for a Flux
// kind, used to build the GVR for a write.
func fluxGroupForKind(kind flux.Kind) (group, fallbackVersion string, ok bool) {
	switch kind {
	case flux.KustomizationKind:
		return "kustomize.toolkit.fluxcd.io", "v1", true
	case flux.HelmReleaseKind:
		return "helm.toolkit.fluxcd.io", "v2", true
	default:
		return "", "", false
	}
}

// gvrForKind resolves the served GVR for a Flux kind via discovery (falling back
// to the documented version when discovery has no groups, e.g. in tests).
func (c *ClusterConn) gvrForKind(kind flux.Kind) (schema.GroupVersionResource, error) {
	group, fallback, ok := fluxGroupForKind(kind)
	if !ok {
		return schema.GroupVersionResource{}, fmt.Errorf("unsupported kind %q", kind)
	}
	resource, ok := flux.ResourceForKind(kind)
	if !ok {
		return schema.GroupVersionResource{}, fmt.Errorf("unsupported kind %q", kind)
	}
	version := preferredVersion(c.typed.Discovery(), group, fallback)
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resource}, nil
}

// Reconcile stamps the Flux reconcile annotation so the controller re-reconciles.
func (c *ClusterConn) Reconcile(ctx context.Context, kind, ns, name string) error {
	gvr, err := c.gvrForKind(flux.Kind(kind))
	if err != nil {
		return err
	}
	body := flux.ReconcilePatch(c.clk.Now())
	_, err = c.dyn.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("reconcile %s %s/%s: %w", kind, ns, name, err)
	}
	return nil
}

// SetSuspend toggles spec.suspend on a Flux resource.
func (c *ClusterConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error {
	gvr, err := c.gvrForKind(flux.Kind(kind))
	if err != nil {
		return err
	}
	body := flux.SuspendPatch(suspend)
	_, err = c.dyn.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("set suspend=%v %s %s/%s: %w", suspend, kind, ns, name, err)
	}
	return nil
}
