package workloads

import (
	"math"
	"testing"
)

const eps = 1e-9

func approxEqual(a, b float64) bool { return math.Abs(a-b) < eps }

func TestWorkloadKey(t *testing.T) {
	w := Workload{Kind: "Deployment", Namespace: "monitoring", Name: "grafana"}
	if got := w.Key(); got != "Deployment/monitoring/grafana" {
		t.Fatalf("key: got %q", got)
	}
}

func TestAggregateUsageSumsOverMatchedPods(t *testing.T) {
	ws := []Workload{{
		Kind: "Deployment", Namespace: "ns", Name: "api",
		Pods: []Pod{{Name: "api-1"}, {Name: "api-2"}},
	}}
	cpu := map[string]float64{"ns/api-1": 0.1, "ns/api-2": 0.2}
	mem := map[string]float64{"ns/api-1": 100, "ns/api-2": 200}
	out := AggregateUsage(ws, cpu, mem)
	u := out["Deployment/ns/api"]
	if u.CPU == nil || !approxEqual(*u.CPU, 0.3) {
		t.Fatalf("cpu: got %v want 0.3", u.CPU)
	}
	if u.Mem == nil || *u.Mem != 300 {
		t.Fatalf("mem: got %v want 300", u.Mem)
	}
}

func TestAggregateUsageNoSamplesIsNil(t *testing.T) {
	ws := []Workload{{Kind: "Deployment", Namespace: "ns", Name: "api", Pods: []Pod{{Name: "api-1"}}}}
	out := AggregateUsage(ws, map[string]float64{}, map[string]float64{})
	u := out["Deployment/ns/api"]
	if u.CPU != nil || u.Mem != nil {
		t.Fatalf("no samples must yield nil cells, got %+v", u)
	}
}

func TestAggregateUsagePartialSamplesBestEffort(t *testing.T) {
	ws := []Workload{{Kind: "Deployment", Namespace: "ns", Name: "api", Pods: []Pod{{Name: "api-1"}, {Name: "api-2"}}}}
	cpu := map[string]float64{"ns/api-1": 0.1} // api-2 missing
	out := AggregateUsage(ws, cpu, map[string]float64{})
	u := out["Deployment/ns/api"]
	if u.CPU == nil || !approxEqual(*u.CPU, 0.1) {
		t.Fatalf("cpu best-effort: got %v want 0.1", u.CPU)
	}
	if u.Mem != nil {
		t.Fatalf("mem: got %v want nil", u.Mem)
	}
}
