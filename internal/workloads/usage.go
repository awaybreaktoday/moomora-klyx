package workloads

import "time"

// Usage is a workload's live resource usage (cpu cores, memory bytes). nil = no
// sample available; never a fabricated zero.
type Usage struct {
	CPU *float64
	Mem *float64
}

// UsageStatus reports whether the metrics source produced a usable result.
// Available=false carries a human Message; UpdatedAt stamps a produced result.
type UsageStatus struct {
	Available bool
	Message   string
	UpdatedAt time.Time
}

// Key is the stable workload identity "<Kind>/<Namespace>/<Name>" shared by the
// health list, the metrics map, and the UI row key.
func (w Workload) Key() string {
	return w.Kind + "/" + w.Namespace + "/" + w.Name
}

// AggregateUsage sums per-pod usage (keyed "<namespace>/<pod>") over each
// workload's matched pods (reusing the join Assemble already performed via
// Workload.Pods — no second matching interpretation). Usage is sampled and
// approximate, so it is best-effort: a cell sums the pods that have a sample and
// is nil only when NONE do.
func AggregateUsage(ws []Workload, cpuByPod, memByPod map[string]float64) map[string]Usage {
	out := make(map[string]Usage, len(ws))
	for _, w := range ws {
		var cpu, mem float64
		var cpuAny, memAny bool
		for _, p := range w.Pods {
			k := w.Namespace + "/" + p.Name
			if v, ok := cpuByPod[k]; ok {
				cpu += v
				cpuAny = true
			}
			if v, ok := memByPod[k]; ok {
				mem += v
				memAny = true
			}
		}
		u := Usage{}
		if cpuAny {
			c := cpu
			u.CPU = &c
		}
		if memAny {
			m := mem
			u.Mem = &m
		}
		out[w.Key()] = u
	}
	return out
}
