package fleet

import (
	"context"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"

	"github.com/moomora/klyx/internal/gitops/flux"
)

type gitopsWatch struct {
	cancel context.CancelFunc
	ksInf  cache.SharedIndexInformer
	hrInf  cache.SharedIndexInformer
}

// preferredVersion returns the served preferred version for a CRD group, or
// fallback when the group is not advertised (the fake discovery in tests has no
// groups, so the fallback is used there).
func preferredVersion(disc discovery.DiscoveryInterface, group, fallback string) string {
	groups, err := disc.ServerGroups()
	if err != nil || groups == nil {
		return fallback
	}
	for _, g := range groups.Groups {
		if g.Name == group {
			if g.PreferredVersion.Version != "" {
				return g.PreferredVersion.Version
			}
			if len(g.Versions) > 0 {
				return g.Versions[0].Version
			}
		}
	}
	return fallback
}

// OpenGitOps starts (idempotently) the lazy dynamic informers on the Flux CRDs.
func (c *ClusterConn) OpenGitOps() {
	c.mu.Lock()
	if c.gitops != nil {
		c.mu.Unlock()
		return
	}
	dyn := c.dyn
	parent := c.ctx
	c.mu.Unlock()
	if dyn == nil || parent == nil {
		return
	}

	ksVer := preferredVersion(c.typed.Discovery(), "kustomize.toolkit.fluxcd.io", "v1")
	hrVer := preferredVersion(c.typed.Discovery(), "helm.toolkit.fluxcd.io", "v2")
	ksGVR := schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: ksVer, Resource: "kustomizations"}
	hrGVR := schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: hrVer, Resource: "helmreleases"}

	gctx, cancel := context.WithCancel(parent)
	factory := dynamicinformer.NewDynamicSharedInformerFactory(dyn, defaultResync)
	ksInf := factory.ForResource(ksGVR).Informer()
	hrInf := factory.ForResource(hrGVR).Informer()
	factory.Start(gctx.Done())

	c.mu.Lock()
	c.gitops = &gitopsWatch{cancel: cancel, ksInf: ksInf, hrInf: hrInf}
	c.mu.Unlock()
}

// CloseGitOps stops the Flux informers.
func (c *ClusterConn) CloseGitOps() {
	c.mu.Lock()
	g := c.gitops
	c.gitops = nil
	c.mu.Unlock()
	if g != nil {
		g.cancel()
	}
}

// GitOpsResources reads the informer stores and parses them. nil when not open.
func (c *ClusterConn) GitOpsResources() []flux.Resource {
	c.mu.RLock()
	g := c.gitops
	c.mu.RUnlock()
	if g == nil {
		return nil
	}
	var out []flux.Resource
	for _, obj := range g.ksInf.GetStore().List() {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			out = append(out, flux.ParseKustomization(u))
		}
	}
	for _, obj := range g.hrInf.GetStore().List() {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			out = append(out, flux.ParseHelmRelease(u))
		}
	}
	return out
}
