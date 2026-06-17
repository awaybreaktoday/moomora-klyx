package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/moomora/klyx/internal/workloads"
)

// fluxEventsCap bounds how many events the detail panel renders per resource.
const fluxEventsCap = 25

// FluxEvents lists core/v1 Events whose involvedObject is this Flux resource -
// the controller's own record of what it did (drift corrections, health-check
// failures, dependency-not-ready). This is the default drift surface: a read of
// Flux's telemetry, no Git fetch or decryption. On-demand; no watch. Warning
// events sort first (SummarizeEvents ordering), capped.
func (c *ClusterConn) FluxEvents(ctx context.Context, kind, ns, name string) ([]workloads.EventSummary, error) {
	// Narrow server-side by name where the apiserver supports it; the fake client
	// ignores field selectors, so we always filter by kind+name below as well.
	list, err := c.typed.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.name=" + name,
		Limit:         200,
	})
	if err != nil {
		return nil, err
	}
	all := workloads.SummarizeEvents(list.Items)
	out := make([]workloads.EventSummary, 0, fluxEventsCap)
	for _, e := range all {
		if e.Kind != kind || e.Name != name {
			continue
		}
		out = append(out, e)
		if len(out) >= fluxEventsCap {
			break
		}
	}
	return out, nil
}
