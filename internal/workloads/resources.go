package workloads

import corev1 "k8s.io/api/core/v1"

// ResourceCell is one resource (cpu cores or memory bytes) for a workload.
// nil encodes the truth, no extra booleans:
//   - Usage   nil → unavailable (Prometheus absent); filled later by the metrics path.
//   - Request nil → not every matched container sets one → renders "—".
//   - Limit   nil → not every matched container is capped → renders "no limit"
//     (for a workload WITH matched pods; with zero pods every cell is nil → "—").
type ResourceCell struct {
	Usage   *float64
	Request *float64
	Limit   *float64
}

// WorkloadResources holds the cpu and memory cells for a workload.
type WorkloadResources struct {
	CPU ResourceCell // cores
	Mem ResourceCell // bytes
}

// aggregateResources computes request/limit from the matched pods' REGULAR
// containers (sidecars included; init containers excluded as transient). Usage is
// left nil. Per resource: Limit/Request is the sum iff EVERY matched container sets
// one, else nil — never sum a partial denominator. No matched pods → all cells nil.
func aggregateResources(pods []*corev1.Pod) WorkloadResources {
	return WorkloadResources{
		CPU: resourceCell(pods, corev1.ResourceCPU),
		Mem: resourceCell(pods, corev1.ResourceMemory),
	}
}

func resourceCell(pods []*corev1.Pod, name corev1.ResourceName) ResourceCell {
	var reqSum, limSum float64
	reqAll, limAll := true, true
	n := 0
	for _, p := range pods {
		for i := range p.Spec.Containers {
			c := &p.Spec.Containers[i]
			n++
			if q, ok := c.Resources.Requests[name]; ok {
				reqSum += q.AsApproximateFloat64()
			} else {
				reqAll = false
			}
			if q, ok := c.Resources.Limits[name]; ok {
				limSum += q.AsApproximateFloat64()
			} else {
				limAll = false
			}
		}
	}
	if n == 0 { // no pods / no containers → nothing to aggregate
		return ResourceCell{}
	}
	cell := ResourceCell{}
	if reqAll {
		cell.Request = &reqSum
	}
	if limAll {
		cell.Limit = &limSum
	}
	return cell
}
