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

func TestAggregateUsageEmptyPodsStillPresent(t *testing.T) {
	// Contract the frontend merge depends on: every workload is emitted under its
	// Key, even with no pods (all-nil cells), so a merge can always find the row.
	ws := []Workload{{Kind: "Deployment", Namespace: "ns", Name: "api", Pods: nil}}
	out := AggregateUsage(ws, map[string]float64{"ns/api-1": 0.1}, map[string]float64{})
	u, ok := out["Deployment/ns/api"]
	if !ok {
		t.Fatalf("workload with empty Pods must still be present in the map")
	}
	if u.CPU != nil || u.Mem != nil {
		t.Fatalf("empty-Pods workload must have all-nil cells, got %+v", u)
	}
}

func TestAggregateUsageMultiWorkloadDistinctValues(t *testing.T) {
	// Guards against pointer aliasing across workloads: each workload's Usage must
	// carry its own value, not share a pointer with another workload.
	ws := []Workload{
		{Kind: "Deployment", Namespace: "ns", Name: "a", Pods: []Pod{{Name: "a-1"}}},
		{Kind: "Deployment", Namespace: "ns", Name: "b", Pods: []Pod{{Name: "b-1"}}},
	}
	cpu := map[string]float64{"ns/a-1": 0.3, "ns/b-1": 0.5}
	out := AggregateUsage(ws, cpu, map[string]float64{})
	a, b := out["Deployment/ns/a"], out["Deployment/ns/b"]
	if a.CPU == nil || b.CPU == nil {
		t.Fatalf("both workloads must have cpu, got a=%v b=%v", a.CPU, b.CPU)
	}
	if !approxEqual(*a.CPU, 0.3) || !approxEqual(*b.CPU, 0.5) {
		t.Fatalf("distinct values expected: a=%v (want 0.3) b=%v (want 0.5)", *a.CPU, *b.CPU)
	}
}
