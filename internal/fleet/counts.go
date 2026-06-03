package fleet

import corev1 "k8s.io/api/core/v1"

// NodeReadiness returns (ready, total) where ready counts nodes whose Ready
// condition is True.
func NodeReadiness(nodes []*corev1.Node) (ready, total int) {
	total = len(nodes)
	for _, n := range nodes {
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
				ready++
				break
			}
		}
	}
	return ready, total
}
