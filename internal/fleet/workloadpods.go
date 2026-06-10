package fleet

import (
	"context"
	"fmt"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WorkloadPods resolves the pod names backing a workload by reading the
// workload's selector and listing pods that match it, sorted. It mirrors the
// kind switch in RolloutRestart; unknown kinds error. Used by the appbridge
// aggregate log stream to fan one stream across all replicas of a workload.
//
// Empty-selector guard: a nil or empty selector matches ZERO pods (never the
// whole namespace), the same convention workloads.matchPods enforces - a
// list-all here would silently tail every pod in the namespace.
func (c *ClusterConn) WorkloadPods(ctx context.Context, kind, namespace, name string) ([]string, error) {
	var selector *metav1.LabelSelector
	var err error

	switch kind {
	case "Deployment":
		d, e := c.typed.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, e
		}
		selector = d.Spec.Selector
	case "StatefulSet":
		s, e := c.typed.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, e
		}
		selector = s.Spec.Selector
	case "DaemonSet":
		ds, e := c.typed.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, e
		}
		selector = ds.Spec.Selector
	default:
		return nil, fmt.Errorf("unsupported kind %q: must be Deployment, StatefulSet, or DaemonSet", kind)
	}

	// Empty/nil selector matches zero pods (never the namespace).
	if selector == nil || (len(selector.MatchLabels) == 0 && len(selector.MatchExpressions) == 0) {
		return nil, nil
	}
	sel, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return nil, fmt.Errorf("workload pods %s %s/%s: %w", kind, namespace, name, err)
	}

	list, err := c.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: sel.String()})
	if err != nil {
		return nil, fmt.Errorf("workload pods %s %s/%s: %w", kind, namespace, name, err)
	}

	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].Name)
	}
	sort.Strings(names)
	return names, nil
}
