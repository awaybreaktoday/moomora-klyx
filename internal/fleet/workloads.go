package fleet

import (
	"context"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/workloads"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ListWorkloads lists Deploy/StatefulSet/DaemonSet + Pods scoped to namespace
// ("" = all; a set namespace scopes the typed list at source) and assembles
// their health. Also returns whether Flux is present (so the UI can distinguish
// "no Flux" from "not Flux-managed"). On-demand; no watch.
func (c *ClusterConn) ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, bool, error) {
	c.mu.RLock()
	fluxPresent := c.caps.GitOps.Flux.Present
	c.mu.RUnlock()

	deps, err := c.typed.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fluxPresent, err
	}
	stss, err := c.typed.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fluxPresent, err
	}
	dss, err := c.typed.AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fluxPresent, err
	}
	pods, err := c.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fluxPresent, err
	}

	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	return workloads.Assemble(deps.Items, stss.Items, dss.Items, pods.Items, fluxPresent, clk.Now()), fluxPresent, nil
}
