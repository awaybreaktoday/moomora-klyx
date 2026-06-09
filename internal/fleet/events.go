package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/moomora/klyx/internal/workloads"
)

// ListEvents lists events scoped to namespace ("" = all) sorted warning-first.
// On-demand; no watch. Capped server-side via limit to keep huge clusters fast.
func (c *ClusterConn) ListEvents(ctx context.Context, namespace string) ([]workloads.EventSummary, error) {
	list, err := c.typed.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{Limit: 500})
	if err != nil {
		return nil, err
	}
	return workloads.SummarizeEvents(list.Items), nil
}
