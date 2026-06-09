package fleet

import (
	"context"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/workloads"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ListPods lists pods scoped to namespace ("" = all; set namespace scopes the
// typed list at source) and classifies them with the shared severity engine.
// On-demand; no watch.
func (c *ClusterConn) ListPods(ctx context.Context, namespace string) ([]workloads.PodSummary, error) {
	pods, err := c.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	return workloads.SummarizePods(pods.Items, clk.Now()), nil
}
