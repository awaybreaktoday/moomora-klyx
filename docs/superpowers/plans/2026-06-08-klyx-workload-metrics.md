# M7-c-ii-b: Workload CPU/Memory metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-workload CPU/memory to the Workloads health view as an additive risk lens — live usage (Prometheus) against the configured limit (pod spec), with saturation colour and a metrics-gated "near limit" sort, never mutating the Kubernetes-derived health rank.

**Architecture:** Mirrors the M7-b RouteMetrics split. Requests/limits are pure, pod-spec-derived, and computed inside the existing `workloads.Assemble` (so they ship with `ListWorkloads` and render even with Prometheus down). Live usage comes from a separate, self-contained `fleet.WorkloadMetrics` (two cAdvisor PromQL queries, aggregated per-workload by reusing each `Workload.Pods` set), exposed via `WorkloadsService.GetWorkloadMetrics` and polled every 30s by the frontend, which patch-merges usage into existing rows and computes saturation/colour at render.

**Tech Stack:** Go 1.26 (`internal/workloads` pure pkg, `internal/fleet`, `internal/appbridge`), client-go typed lists, Prometheus instant-vector client (`internal/metrics`), Wails v3 bindings, React 19 + TS + Zustand 5 + Vitest 4.

**Branch:** `feat/m7cii-b-workload-metrics` off `main`.

**Spec:** `docs/superpowers/specs/2026-06-08-klyx-workload-metrics-design.md`

---

## File Structure

**Created:**
- `internal/workloads/resources.go` — `ResourceCell`/`WorkloadResources` types + `aggregateResources` (req/limit from matched pods' regular containers; any-uncapped → nil; no pods → nil).
- `internal/workloads/resources_test.go`
- `internal/workloads/usage.go` — `Usage`/`UsageStatus` types, `Workload.Key()`, pure `AggregateUsage` (sum per-pod usage over each workload's matched pods).
- `internal/workloads/usage_test.go`
- `internal/fleet/workload_metrics.go` — `WorkloadMetrics(ctx, ns)`: self-contained Prometheus usage enrichment.
- `internal/fleet/workload_metrics_test.go`
- `cmd/klyx/frontend/src/cluster/saturation.ts` — pure `saturation()` + `nearLimitSort()` + `fmtCpu`/`fmtMem`.
- `cmd/klyx/frontend/src/cluster/saturation.test.ts`
- `cmd/klyx/frontend/src/bridge/workload-metrics.ts` — `getWorkloadMetrics` poller.

**Modified:**
- `internal/workloads/model.go` — add `Resources WorkloadResources` to `Workload`.
- `internal/workloads/assemble.go` — `build` calls `aggregateResources`.
- `internal/fleet/conn.go` — add `WorkloadMetrics` to `Conn` interface.
- `internal/fleet/registry_test.go` — add `WorkloadMetrics` stub to `fakeConn`.
- `internal/appbridge/workloads_dto.go` — `ResourceCellDTO`/`WorkloadResourcesDTO` + `Resources` on `WorkloadDTO`; `WorkloadMetrics*DTO`.
- `internal/appbridge/workloads_service.go` — `toWorkloadDTO` fills `Resources`; add `GetWorkloadMetrics`; extend `WorkloadsConn`.
- `internal/appbridge/workloads_service_test.go` — `WorkloadMetrics` stub on `fakeWLConn` + tests.
- `cmd/klyx/frontend/src/store/fleet.ts` — `ResourceCellDTO`/`WorkloadResourcesDTO` types, `resources` on `WorkloadDTO`, usage slice fields, `setWorkloadUsage`, `toggleNearLimitSort`.
- `cmd/klyx/frontend/src/store/workloads.test.ts` — patch-merge + near-limit-sort + capability tests.
- `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx` — cpu/mem columns (gated), bars, expand D-block, near-limit chip, 30s lifecycle.
- `cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx` — gated-absence + render tests.

---

## Task 1: Pure request/limit aggregation (`internal/workloads/resources.go`)

**Files:**
- Create: `internal/workloads/resources.go`, `internal/workloads/resources_test.go`
- Modify: `internal/workloads/model.go`, `internal/workloads/assemble.go`

- [ ] **Step 1: Write the failing test**

Create `internal/workloads/resources_test.go`:

```go
package workloads

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func ctr(name string, reqCPU, limCPU, reqMem, limMem string) corev1.Container {
	c := corev1.Container{Name: name, Resources: corev1.ResourceRequirements{
		Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{},
	}}
	if reqCPU != "" {
		c.Resources.Requests[corev1.ResourceCPU] = resource.MustParse(reqCPU)
	}
	if limCPU != "" {
		c.Resources.Limits[corev1.ResourceCPU] = resource.MustParse(limCPU)
	}
	if reqMem != "" {
		c.Resources.Requests[corev1.ResourceMemory] = resource.MustParse(reqMem)
	}
	if limMem != "" {
		c.Resources.Limits[corev1.ResourceMemory] = resource.MustParse(limMem)
	}
	return c
}

func podWith(containers ...corev1.Container) *corev1.Pod {
	return &corev1.Pod{Spec: corev1.PodSpec{Containers: containers}}
}

func TestAggregateResourcesAllCapped(t *testing.T) {
	pods := []*corev1.Pod{podWith(ctr("app", "250m", "500m", "256Mi", "512Mi"))}
	r := aggregateResources(pods)
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.5 {
		t.Fatalf("cpu limit: got %v want 0.5", r.CPU.Limit)
	}
	if r.CPU.Request == nil || *r.CPU.Request != 0.25 {
		t.Fatalf("cpu request: got %v want 0.25", r.CPU.Request)
	}
	if r.Mem.Limit == nil || *r.Mem.Limit != 512*1024*1024 {
		t.Fatalf("mem limit: got %v want 536870912", r.Mem.Limit)
	}
	if r.Mem.Usage != nil {
		t.Fatalf("usage must be nil (filled later), got %v", r.Mem.Usage)
	}
}

func TestAggregateResourcesAnyUncappedMeansNilLimit(t *testing.T) {
	// sidecar has no memory limit -> workload mem limit nil (no limit), cpu still summed
	pods := []*corev1.Pod{podWith(
		ctr("app", "250m", "500m", "256Mi", "512Mi"),
		ctr("sidecar", "50m", "100m", "64Mi", ""), // no mem limit
	)}
	r := aggregateResources(pods)
	if r.Mem.Limit != nil {
		t.Fatalf("mem limit must be nil when any container uncapped, got %v", *r.Mem.Limit)
	}
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.6 {
		t.Fatalf("cpu limit: got %v want 0.6 (0.5+0.1)", r.CPU.Limit)
	}
}

func TestAggregateResourcesMissingRequestMeansNil(t *testing.T) {
	pods := []*corev1.Pod{podWith(ctr("app", "", "500m", "256Mi", "512Mi"))} // no cpu request
	r := aggregateResources(pods)
	if r.CPU.Request != nil {
		t.Fatalf("cpu request must be nil when any container lacks it, got %v", *r.CPU.Request)
	}
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.5 {
		t.Fatalf("cpu limit should still be 0.5, got %v", r.CPU.Limit)
	}
}

func TestAggregateResourcesNoPodsAllNil(t *testing.T) {
	r := aggregateResources(nil)
	if r.CPU.Limit != nil || r.CPU.Request != nil || r.Mem.Limit != nil || r.Mem.Request != nil {
		t.Fatalf("no pods must yield all-nil cells, got %+v", r)
	}
}

func TestAggregateResourcesInitContainersExcluded(t *testing.T) {
	// init container with no limit must NOT flip the workload to "no limit"
	p := podWith(ctr("app", "250m", "500m", "256Mi", "512Mi"))
	p.Spec.InitContainers = []corev1.Container{ctr("init", "", "", "", "")}
	r := aggregateResources([]*corev1.Pod{p})
	if r.Mem.Limit == nil || *r.Mem.Limit != 512*1024*1024 {
		t.Fatalf("init container must be excluded; mem limit should be 512Mi, got %v", r.Mem.Limit)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/workloads/ -run TestAggregateResources -v`
Expected: FAIL — `undefined: aggregateResources`, `r.CPU` undefined.

- [ ] **Step 3: Add the types to `model.go`**

In `internal/workloads/model.go`, add `Resources` to `Workload` (after the `Pods []Pod` field):

```go
type Workload struct {
	Kind, Namespace, Name              string
	Desired, Ready, Available, Updated int
	Restarts                           int
	Reason                             string // single human-facing status string
	Rank                               HealthRank
	GitOps                             *Owner
	Pods                               []Pod
	Resources                          WorkloadResources
}
```

- [ ] **Step 4: Create `internal/workloads/resources.go`**

```go
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/workloads/ -run TestAggregateResources -v`
Expected: PASS (all 5).

- [ ] **Step 6: Wire `aggregateResources` into `build`**

In `internal/workloads/assemble.go`, inside `build`, after the `w.GitOps` block and before `return w` (so `matched` is in scope):

```go
	if fluxPresent {
		w.GitOps = extractOwner(objLabels)
	}
	w.Resources = aggregateResources(matched)
	return w
```

- [ ] **Step 7: Run the full package suite**

Run: `go test ./internal/workloads/ && go test -race ./internal/workloads/ && gofmt -l internal/workloads/ && go vet ./internal/workloads/`
Expected: PASS; `gofmt -l` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add internal/workloads/resources.go internal/workloads/resources_test.go internal/workloads/model.go internal/workloads/assemble.go
git commit -m "feat(workloads): pod-spec request/limit aggregation (any-uncapped => no limit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure usage aggregation (`internal/workloads/usage.go`)

**Files:**
- Create: `internal/workloads/usage.go`, `internal/workloads/usage_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/workloads/usage_test.go`:

```go
package workloads

import "testing"

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
	if u.CPU == nil || *u.CPU != 0.3 {
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
	// usage is sampled/approximate: sum the pods that DO have a sample, nil only if none.
	ws := []Workload{{Kind: "Deployment", Namespace: "ns", Name: "api", Pods: []Pod{{Name: "api-1"}, {Name: "api-2"}}}}
	cpu := map[string]float64{"ns/api-1": 0.1} // api-2 missing
	out := AggregateUsage(ws, cpu, map[string]float64{})
	u := out["Deployment/ns/api"]
	if u.CPU == nil || *u.CPU != 0.1 {
		t.Fatalf("cpu best-effort: got %v want 0.1", u.CPU)
	}
	if u.Mem != nil {
		t.Fatalf("mem: got %v want nil", u.Mem)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/workloads/ -run "TestWorkloadKey|TestAggregateUsage" -v`
Expected: FAIL — `undefined: Workload.Key`, `undefined: AggregateUsage`, `undefined: Usage`.

- [ ] **Step 3: Create `internal/workloads/usage.go`**

```go
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/workloads/ -run "TestWorkloadKey|TestAggregateUsage" -v`
Expected: PASS (4).

- [ ] **Step 5: Run the full package suite + commit**

Run: `go test -race ./internal/workloads/ && gofmt -l internal/workloads/ && go vet ./internal/workloads/`
Expected: PASS; no gofmt output.

```bash
git add internal/workloads/usage.go internal/workloads/usage_test.go
git commit -m "feat(workloads): Usage/UsageStatus + Key + pure AggregateUsage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Fleet usage enrichment (`internal/fleet/workload_metrics.go`)

**Files:**
- Create: `internal/fleet/workload_metrics.go`, `internal/fleet/workload_metrics_test.go`
- Modify: `internal/fleet/conn.go`, `internal/fleet/registry_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/workload_metrics_test.go`. This drives `queryByPod` (the pure label→key reducer) directly, which is the part most worth pinning; the live `WorkloadMetrics` wiring is exercised by native verification in Task 7.

```go
package fleet

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/metrics"
)

// fakeQuerier returns a canned Prometheus vector JSON body for any query.
type fakeQuerier struct{ body string }

func (f fakeQuerier) InstantQuery(_ context.Context, _ string) (int, []byte, error) {
	return 200, []byte(f.body), nil
}

func TestQueryByPodMapsNamespacePodLabels(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"namespace":"ns","pod":"api-1"},"value":[0,"0.10"]},
		{"metric":{"namespace":"ns","pod":"api-2"},"value":[0,"0.20"]},
		{"metric":{"pod":"no-ns"},"value":[0,"0.99"]}
	]}}`
	cl := metrics.NewClient(fakeQuerier{body: body})
	got, err := queryByPod(context.Background(), cl, "irrelevant")
	if err != nil {
		t.Fatal(err)
	}
	if got["ns/api-1"] != 0.10 || got["ns/api-2"] != 0.20 {
		t.Fatalf("got %v", got)
	}
	if _, ok := got["/no-ns"]; ok {
		t.Fatalf("sample missing a namespace label must be dropped, got %v", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/fleet/ -run TestQueryByPod -v`
Expected: FAIL — `undefined: queryByPod`.

- [ ] **Step 3: Create `internal/fleet/workload_metrics.go`**

```go
package fleet

import (
	"context"
	"fmt"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/metrics"
	"github.com/moomora/klyx/internal/workloads"
)

// cAdvisor series confirmed present on the homelab. container!="",container!="POD"
// drops the pod-sandbox/empty rollup series. %s is the namespace matcher (empty for
// cluster-wide). The [5m] rate window is the v1 default.
const (
	wlCPUQuery = `sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{%scontainer!="",container!="POD"}[5m]))`
	wlMemQuery = `sum by (namespace,pod) (container_memory_working_set_bytes{%scontainer!="",container!="POD"})`
)

// WorkloadMetrics returns live per-workload cpu/memory usage keyed by the stable
// "<Kind>/<Namespace>/<Name>", plus a status. Self-contained (mirrors RouteMetrics):
// it re-lists workloads+pods to reuse Assemble's pod→workload join, then enriches
// with Prometheus usage. Usage only — requests/limits already ship with ListWorkloads.
func (c *ClusterConn) WorkloadMetrics(ctx context.Context, namespace string) (map[string]workloads.Usage, workloads.UsageStatus) {
	clk := c.clk
	if clk == nil { // defensive: manual struct construction in tests
		clk = clock.Real{}
	}
	now := clk.Now()

	ws, _, err := c.ListWorkloads(ctx, namespace)
	if err != nil {
		return nil, workloads.UsageStatus{Available: false, Message: "workload list failed: " + err.Error()}
	}

	c.metricsMu.Lock()
	c.ensureMetricsLocked(ctx, false, now)
	cap := c.metricsState.cap
	transport := c.metricsState.transport
	c.metricsMu.Unlock()

	if !cap.Available {
		msg := "metrics unavailable"
		if cap.Reason != "" {
			msg += ": " + cap.Reason
		}
		return nil, workloads.UsageStatus{Available: false, Message: msg}
	}

	nsMatch := ""
	if namespace != "" {
		nsMatch = fmt.Sprintf("namespace=%q,", namespace)
	}
	cl := metrics.NewClient(transport)
	cpuByPod, err := queryByPod(ctx, cl, fmt.Sprintf(wlCPUQuery, nsMatch))
	if err != nil {
		return nil, workloads.UsageStatus{Available: false, Message: "cpu usage query failed: " + err.Error()}
	}
	memByPod, err := queryByPod(ctx, cl, fmt.Sprintf(wlMemQuery, nsMatch))
	if err != nil {
		return nil, workloads.UsageStatus{Available: false, Message: "memory usage query failed: " + err.Error()}
	}

	return workloads.AggregateUsage(ws, cpuByPod, memByPod), workloads.UsageStatus{Available: true, UpdatedAt: now}
}

// queryByPod runs a `sum by (namespace,pod)` instant query and reduces it to
// "<namespace>/<pod>" → value. Samples missing either label are dropped (no
// ambiguous key). NaN/Inf are already skipped by InstantVector.
func queryByPod(ctx context.Context, cl *metrics.Client, promql string) (map[string]float64, error) {
	samples, err := cl.InstantVector(ctx, promql)
	if err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(samples))
	for _, s := range samples {
		ns, pod := s.Labels["namespace"], s.Labels["pod"]
		if ns == "" || pod == "" {
			continue
		}
		out[ns+"/"+pod] = s.Value
	}
	return out, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/fleet/ -run TestQueryByPod -v`
Expected: PASS.

- [ ] **Step 5: Add `WorkloadMetrics` to the `Conn` interface**

In `internal/fleet/conn.go`, in the `Conn interface` block, directly after the `ListWorkloads(...)` line (currently line ~43):

```go
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, bool, error)
	WorkloadMetrics(ctx context.Context, namespace string) (map[string]workloads.Usage, workloads.UsageStatus)
```

- [ ] **Step 6: Add the `fakeConn` stub**

In `internal/fleet/registry_test.go`, after the `fakeConn.ListWorkloads` stub (line ~46):

```go
func (f *fakeConn) WorkloadMetrics(context.Context, string) (map[string]workloads.Usage, workloads.UsageStatus) {
	return nil, workloads.UsageStatus{}
}
```

- [ ] **Step 7: Run the fleet suite + commit**

Run: `go test ./internal/fleet/ && go test -race ./internal/fleet/ && gofmt -l internal/fleet/ && go vet ./internal/fleet/`
Expected: PASS; no gofmt output. (If `fakeConn` already implements `Conn` via an assertion like `var _ Conn = (*fakeConn)(nil)`, this is what catches a missing stub — it must compile.)

```bash
git add internal/fleet/workload_metrics.go internal/fleet/workload_metrics_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): WorkloadMetrics — self-contained Prometheus usage enrichment

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Appbridge DTOs + GetWorkloadMetrics (`internal/appbridge`)

**Files:**
- Modify: `internal/appbridge/workloads_dto.go`, `internal/appbridge/workloads_service.go`, `internal/appbridge/workloads_service_test.go`

- [ ] **Step 1: Write the failing test**

In `internal/appbridge/workloads_service_test.go`, add the `WorkloadMetrics` stub to `fakeWLConn` and a new test. First the stub (next to the existing `fakeWLConn.ListWorkloads`):

```go
func (f fakeWLConn) WorkloadMetrics(context.Context, string) (map[string]workloads.Usage, workloads.UsageStatus) {
	cpu := 0.3
	return map[string]workloads.Usage{"Deployment/ns/api": {CPU: &cpu}}, workloads.UsageStatus{Available: true}
}
```

Then the test (the existing `fakeWLConn` is returned by a lookup that maps `"c"` → conn; mirror that):

```go
func TestGetWorkloadMetricsDTO(t *testing.T) {
	s := NewWorkloadsService(func(name string) (WorkloadsConn, bool) {
		if name == "c" {
			return fakeWLConn{}, true
		}
		return nil, false
	})

	t.Run("cluster miss returns non-nil empty + unavailable", func(t *testing.T) {
		r := s.GetWorkloadMetrics("nope", "")
		if r.Usage == nil || len(r.Usage) != 0 || r.Status.Available {
			t.Fatalf("got %+v", r)
		}
	})

	t.Run("maps usage by workload key", func(t *testing.T) {
		r := s.GetWorkloadMetrics("c", "")
		if !r.Status.Available {
			t.Fatalf("status: %+v", r.Status)
		}
		u, ok := r.Usage["Deployment/ns/api"]
		if !ok || u.CPUUsage == nil || *u.CPUUsage != 0.3 {
			t.Fatalf("usage: %+v", r.Usage)
		}
		if u.MemUsage != nil {
			t.Fatalf("mem should be nil, got %v", *u.MemUsage)
		}
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGetWorkloadMetricsDTO -v`
Expected: FAIL — `undefined: WorkloadsService.GetWorkloadMetrics`, `undefined: WorkloadUsageDTO`, and a compile error that `fakeWLConn` does not satisfy `WorkloadsConn` (missing method).

- [ ] **Step 3: Add the DTOs**

In `internal/appbridge/workloads_dto.go`, add the resource cell to `WorkloadDTO` and the new metrics DTOs:

```go
// ResourceCellDTO is one resource (cpu cores / memory bytes). Nil = JSON null →
// UI renders "—" (or "no limit" for a nil Limit with matched pods). Never 0.
type ResourceCellDTO struct {
	Usage   *float64 `json:"usage"`
	Request *float64 `json:"request"`
	Limit   *float64 `json:"limit"`
}

type WorkloadResourcesDTO struct {
	CPU ResourceCellDTO `json:"cpu"`
	Mem ResourceCellDTO `json:"mem"`
}

type WorkloadMetricsStatusDTO struct {
	Available bool   `json:"available"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updatedAt"` // RFC3339; "" when never succeeded
}

type WorkloadUsageDTO struct {
	CPUUsage *float64 `json:"cpuUsage"`
	MemUsage *float64 `json:"memUsage"`
}

type WorkloadMetricsResultDTO struct {
	Status WorkloadMetricsStatusDTO    `json:"status"`
	Usage  map[string]WorkloadUsageDTO `json:"usage"` // keyed "<kind>/<ns>/<name>"
}
```

And add `Resources` to the `WorkloadDTO` struct (after the `Pods []PodDTO` field):

```go
	Pods      []PodDTO             `json:"pods"`
	Resources WorkloadResourcesDTO `json:"resources"`
```

- [ ] **Step 4: Fill `Resources` in `toWorkloadDTO` + add `GetWorkloadMetrics` + extend the interface**

In `internal/appbridge/workloads_service.go`:

Extend the interface:

```go
type WorkloadsConn interface {
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, bool, error)
	WorkloadMetrics(ctx context.Context, namespace string) (map[string]workloads.Usage, workloads.UsageStatus)
}
```

In `toWorkloadDTO`, before `return d`, add:

```go
	d.Resources = WorkloadResourcesDTO{
		CPU: ResourceCellDTO{Usage: w.Resources.CPU.Usage, Request: w.Resources.CPU.Request, Limit: w.Resources.CPU.Limit},
		Mem: ResourceCellDTO{Usage: w.Resources.Mem.Usage, Request: w.Resources.Mem.Request, Limit: w.Resources.Mem.Limit},
	}
```

Add the new service method (after `ListWorkloads`):

```go
// GetWorkloadMetrics returns live per-workload cpu/memory usage keyed by
// "<kind>/<ns>/<name>" plus a status. On-demand; the frontend polls it. Usage
// only — requests/limits already ship with ListWorkloads. Cluster miss / failure
// returns a non-nil empty map with an unavailable status (never panics on null).
func (s *WorkloadsService) GetWorkloadMetrics(cluster, namespace string) WorkloadMetricsResultDTO {
	empty := WorkloadMetricsResultDTO{Usage: map[string]WorkloadUsageDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		empty.Status = WorkloadMetricsStatusDTO{Available: false, Message: "cluster not connected"}
		return empty
	}
	ctx, cancel := context.WithTimeout(context.Background(), workloadsTimeout)
	defer cancel()
	usage, st := conn.WorkloadMetrics(ctx, namespace)
	out := make(map[string]WorkloadUsageDTO, len(usage))
	for k, u := range usage {
		out[k] = WorkloadUsageDTO{CPUUsage: u.CPU, MemUsage: u.Mem}
	}
	updatedAt := ""
	if !st.UpdatedAt.IsZero() {
		updatedAt = st.UpdatedAt.Format(time.RFC3339)
	}
	return WorkloadMetricsResultDTO{
		Status: WorkloadMetricsStatusDTO{Available: st.Available, Message: st.Message, UpdatedAt: updatedAt},
		Usage:  out,
	}
}
```

`time` is already imported in `workloads_service.go` (used by `workloadsTimeout`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/appbridge/ -run "TestGetWorkloadMetricsDTO|TestListWorkloadsDTO" -v`
Expected: PASS.

- [ ] **Step 6: Run the appbridge suite + commit**

Run: `go test -race ./internal/appbridge/ && gofmt -l internal/appbridge/ && go vet ./internal/appbridge/`
Expected: PASS; no gofmt output.

```bash
git add internal/appbridge/workloads_dto.go internal/appbridge/workloads_service.go internal/appbridge/workloads_service_test.go
git commit -m "feat(appbridge): WorkloadDTO.Resources + GetWorkloadMetrics usage map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Frontend store + pure saturation util

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/saturation.ts`, `cmd/klyx/frontend/src/cluster/saturation.test.ts`
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/store/workloads.test.ts`

- [ ] **Step 1: Write the failing saturation test**

Create `cmd/klyx/frontend/src/cluster/saturation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { saturation, nearLimitSort, fmtCpu, fmtMem } from "./saturation";
import type { WorkloadDTO } from "../store/fleet";

const Mi = 1048576;

describe("saturation", () => {
  it("memory tiers: 90% danger, 75% warn, below neutral", () => {
    expect(saturation("mem", 470, 512).tier).toBe("danger"); // .918
    expect(saturation("mem", 400, 512).tier).toBe("warn");   // .781
    expect(saturation("mem", 200, 512).tier).toBe("neutral");
  });
  it("cpu tiers: 100% danger, 90% warn, below neutral", () => {
    expect(saturation("cpu", 0.55, 0.5).tier).toBe("danger");
    expect(saturation("cpu", 0.46, 0.5).tier).toBe("warn");
    expect(saturation("cpu", 0.2, 0.5).tier).toBe("neutral");
  });
  it("no calculable saturation when usage or limit absent", () => {
    expect(saturation("mem", null, 512)).toEqual({ pct: null, tier: "none" });
    expect(saturation("mem", 470, null)).toEqual({ pct: null, tier: "none" });
    expect(saturation("cpu", 0.5, 0)).toEqual({ pct: null, tier: "none" });
  });
});

const wl = (name: string, memUsage: number | null, memLimit: number | null, rank: WorkloadDTO["rank"] = "healthy"): WorkloadDTO => ({
  kind: "Deployment", namespace: "ns", name, desired: 1, ready: 1, available: 1, updated: 1,
  restarts: 0, reason: "", rank, gitops: null, pods: [],
  resources: { cpu: { usage: null, request: null, limit: null }, mem: { usage: memUsage, request: null, limit: memLimit } },
});

describe("nearLimitSort", () => {
  it("orders by mem saturation desc; no-calc rows sink below", () => {
    const rows = [wl("low", 100 * Mi, 1000 * Mi), wl("nolimit", 900 * Mi, null), wl("high", 950 * Mi, 1000 * Mi)];
    const out = nearLimitSort(rows).map((r) => r.name);
    expect(out).toEqual(["high", "low", "nolimit"]);
  });
  it("ties (both no-calc) fall back to k8s rank then name", () => {
    const a = wl("b-name", null, null, "healthy");
    const b = wl("a-name", null, null, "unhealthy");
    const out = nearLimitSort([a, b]).map((r) => r.name);
    expect(out).toEqual(["a-name", "b-name"]); // unhealthy (rank 0) first
  });
});

describe("formatting", () => {
  it("cpu millicores below 1 core, cores above", () => {
    expect(fmtCpu(0.18)).toBe("180m");
    expect(fmtCpu(1.1)).toBe("1.10");
  });
  it("mem Mi below 1Gi, Gi above", () => {
    expect(fmtMem(470 * Mi)).toBe("470Mi");
    expect(fmtMem(2 * 1024 * Mi)).toBe("2.0Gi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/saturation.test.ts`
Expected: FAIL — cannot resolve `./saturation`.

- [ ] **Step 3: Create `cmd/klyx/frontend/src/cluster/saturation.ts`**

```ts
import type { WorkloadDTO } from "../store/fleet";

export type SatTier = "none" | "neutral" | "warn" | "danger";
export type Resource = "cpu" | "mem";

// saturation returns usage/limit and its risk tier. CPU and memory are asymmetric:
// memory limit is a hard OOM ceiling (75% warn, 90% danger); cpu limit is throttling
// proximity (90% warn, 100% danger). No usage or no limit → no calculable saturation.
export function saturation(resource: Resource, usage: number | null, limit: number | null): { pct: number | null; tier: SatTier } {
  if (usage == null || limit == null || limit <= 0) return { pct: null, tier: "none" };
  const pct = usage / limit;
  if (resource === "mem") {
    if (pct >= 0.9) return { pct, tier: "danger" };
    if (pct >= 0.75) return { pct, tier: "warn" };
    return { pct, tier: "neutral" };
  }
  if (pct >= 1.0) return { pct, tier: "danger" };
  if (pct >= 0.9) return { pct, tier: "warn" };
  return { pct, tier: "neutral" };
}

const RANK_ORDER: Record<WorkloadDTO["rank"], number> = { unhealthy: 0, degraded: 1, restarts: 2, healthy: 3 };

function memSat(w: WorkloadDTO): number {
  const s = saturation("mem", w.resources.mem.usage, w.resources.mem.limit);
  return s.pct ?? -1; // no calculable saturation sinks below any calculable one
}
function cpuSat(w: WorkloadDTO): number {
  const s = saturation("cpu", w.resources.cpu.usage, w.resources.cpu.limit);
  return s.pct ?? -1;
}

// nearLimitSort: mem saturation desc → cpu saturation desc → k8s rank → ns/name.
// Rows with no calculable saturation (no limit OR usage absent) sort below calculable
// ones; full ties fall back to rank then namespace/name. Pure, returns a new array.
export function nearLimitSort(items: WorkloadDTO[]): WorkloadDTO[] {
  return [...items].sort((a, b) => {
    const dm = memSat(b) - memSat(a);
    if (dm !== 0) return dm;
    const dc = cpuSat(b) - cpuSat(a);
    if (dc !== 0) return dc;
    const dr = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
    if (dr !== 0) return dr;
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function fmtCpu(cores: number): string {
  return cores >= 1 ? cores.toFixed(2) : `${Math.round(cores * 1000)}m`;
}

export function fmtMem(bytes: number): string {
  const Mi = 1048576, Gi = 1073741824;
  return bytes >= Gi ? `${(bytes / Gi).toFixed(1)}Gi` : `${Math.round(bytes / Mi)}Mi`;
}
```

- [ ] **Step 4: Run the saturation test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/saturation.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the store — types, slice, actions**

In `cmd/klyx/frontend/src/store/fleet.ts`:

Add the resource types and extend `WorkloadDTO` (replace the existing `WorkloadDTO`/`PodDTO` block):

```ts
export type PodDTO = { name: string; ready: boolean; restarts: number; reason: string; node: string; ageSeconds: number };
export type ResourceCellDTO = { usage: number | null; request: number | null; limit: number | null };
export type WorkloadResourcesDTO = { cpu: ResourceCellDTO; mem: ResourceCellDTO };
export type WorkloadDTO = { kind: string; namespace: string; name: string; desired: number; ready: number; available: number; updated: number; restarts: number; reason: string; rank: "unhealthy"|"degraded"|"restarts"|"healthy"; gitops: OwnerDTO | null; pods: PodDTO[]; resources: WorkloadResourcesDTO };
export type WorkloadUsageDTO = { cpuUsage: number | null; memUsage: number | null };
export type WorkloadMetricsStatusDTO = { available: boolean; message: string; updatedAt: string };
export type WorkloadMetricsResultDTO = { status: WorkloadMetricsStatusDTO; usage: Record<string, WorkloadUsageDTO> };
```

Extend `WorkloadsSlice` (add the four fields after `expanded`):

```ts
export type WorkloadsSlice = {
  cluster: string | null;
  namespace: string;
  items: WorkloadDTO[];
  namespaces: string[];
  fluxPresent: boolean;
  loading: boolean;
  kindFilter: Record<WorkloadKind, boolean>;
  needsAttention: boolean;
  expanded: string[];
  metricsAvailable: boolean;        // gates cpu/mem columns + near-limit control
  metricsStatus: WorkloadMetricsStatusDTO | null;
  metricsStale: boolean;
  nearLimitSort: boolean;
};
```

Add the action signatures (next to the other workloads action types, ~line 217):

```ts
  setWorkloadUsage: (cluster: string, namespace: string, result: WorkloadMetricsResultDTO) => void;
  toggleNearLimitSort: () => void;
```

Update the initial workloads state (~line 320) to include the new fields:

```ts
  workloads: { cluster: null, namespace: "", items: [], namespaces: [], fluxPresent: false, loading: false,
    kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true }, needsAttention: false, expanded: [],
    metricsAvailable: false, metricsStatus: null, metricsStale: false, nearLimitSort: false },
```

Update `clearWorkloads` to also reset the new fields (find the existing `clearWorkloads` and add them):

```ts
  clearWorkloads: () => set((s) => ({ workloads: { ...s.workloads, cluster: null, items: [], namespaces: [], expanded: [], needsAttention: false, namespace: "", kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true }, metricsAvailable: false, metricsStatus: null, metricsStale: false, nearLimitSort: false } })),
```

Add the two new actions (next to `setWorkloads`):

```ts
  setWorkloadUsage: (cluster, namespace, result) =>
    set((s) => {
      // ignore a stale response from a cluster/namespace we've navigated away from
      if (s.workloads.cluster !== cluster || s.workloads.namespace !== namespace) return {};
      if (result.status.available) {
        // PATCH usage into existing rows by key; never replace structural rows.
        const items = s.workloads.items.map((w) => {
          const u = result.usage[`${w.kind}/${w.namespace}/${w.name}`];
          if (!u) return w;
          return { ...w, resources: {
            cpu: { ...w.resources.cpu, usage: u.cpuUsage },
            mem: { ...w.resources.mem, usage: u.memUsage },
          } };
        });
        return { workloads: { ...s.workloads, items, metricsAvailable: true, metricsStatus: result.status, metricsStale: false } };
      }
      // transient/first failure: keep last-good usage + updatedAt, mark stale.
      const keptUpdatedAt = s.workloads.metricsStatus?.updatedAt ?? "";
      return { workloads: { ...s.workloads, metricsStatus: { ...result.status, updatedAt: keptUpdatedAt }, metricsStale: s.workloads.metricsAvailable } };
    }),
  toggleNearLimitSort: () => set((s) => ({ workloads: { ...s.workloads, nearLimitSort: !s.workloads.nearLimitSort } })),
```

Note: a metrics-unavailable response keeps `metricsAvailable` at its prior value (false on first load), so the columns simply never appear when there's no source — but does NOT flip a previously-true availability to false on a transient hiccup (that path only marks stale).

- [ ] **Step 6: Write store tests for patch-merge + capability**

In `cmd/klyx/frontend/src/store/workloads.test.ts`, add (the file already imports `useFleet` and uses `setWorkloads`; mirror its setup):

```ts
  it("setWorkloadUsage patches usage by key without replacing rows", () => {
    const f = useFleet.getState();
    f.setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [
      { kind: "Deployment", namespace: "ns", name: "api", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "Available", rank: "healthy", gitops: null, pods: [],
        resources: { cpu: { usage: null, request: 0.25, limit: 0.5 }, mem: { usage: null, request: null, limit: 536870912 } } },
    ] });
    f.setWorkloadUsage("c", "", { status: { available: true, message: "", updatedAt: "t1" }, usage: { "Deployment/ns/api": { cpuUsage: 0.3, memUsage: 400000000 } } });
    const w = useFleet.getState().workloads.items[0];
    expect(w.resources.cpu.usage).toBe(0.3);
    expect(w.resources.cpu.limit).toBe(0.5);     // structural data preserved
    expect(w.reason).toBe("Available");          // row not replaced
    expect(useFleet.getState().workloads.metricsAvailable).toBe(true);
  });

  it("setWorkloadUsage transient failure keeps last-good usage, marks stale", () => {
    const f = useFleet.getState();
    f.setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: [
      { kind: "Deployment", namespace: "ns", name: "api", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "", rank: "healthy", gitops: null, pods: [],
        resources: { cpu: { usage: null, request: null, limit: 0.5 }, mem: { usage: null, request: null, limit: null } } },
    ] });
    f.setWorkloadUsage("c", "", { status: { available: true, message: "", updatedAt: "t1" }, usage: { "Deployment/ns/api": { cpuUsage: 0.3, memUsage: null } } });
    f.setWorkloadUsage("c", "", { status: { available: false, message: "down", updatedAt: "" }, usage: {} });
    const s = useFleet.getState().workloads;
    expect(s.items[0].resources.cpu.usage).toBe(0.3); // kept
    expect(s.metricsStale).toBe(true);
  });
```

- [ ] **Step 7: Run frontend tests for the changed files**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/saturation.test.ts src/store/workloads.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/saturation.ts cmd/klyx/frontend/src/cluster/saturation.test.ts cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/workloads.test.ts
git commit -m "feat(ui): workload resources types, usage patch-merge, near-limit sort + saturation util

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Frontend poller + WorkloadsView rendering

**Files:**
- Create: `cmd/klyx/frontend/src/bridge/workload-metrics.ts`
- Modify: `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`, `cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx`

- [ ] **Step 1: Create the poller bridge**

Create `cmd/klyx/frontend/src/bridge/workload-metrics.ts`:

```ts
import { useFleet, WorkloadMetricsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

// getWorkloadMetrics fetches live usage and patch-merges it into the current rows.
// Stale-guarded on cluster+namespace. Failures are swallowed (the store keeps
// last-good usage and marks stale); the loading flag is owned by listWorkloads.
export async function getWorkloadMetrics(cluster: string, namespace: string): Promise<void> {
  try {
    const r = (await WorkloadsService.GetWorkloadMetrics(cluster, namespace)) as WorkloadMetricsResultDTO;
    useFleet.getState().setWorkloadUsage(cluster, namespace, r ?? { status: { available: false, message: "", updatedAt: "" }, usage: {} });
  } catch {
    useFleet.getState().setWorkloadUsage(cluster, namespace, { status: { available: false, message: "metrics request failed", updatedAt: "" }, usage: {} });
  }
}
```

- [ ] **Step 2: Write the failing view test**

In `cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx`, add tests for the capability gate. (The file already renders `WorkloadsView` and seeds the store via `setWorkloads`; mirror its existing setup and any `WorkloadsService` mock. The metrics bridge calls `WorkloadsService.GetWorkloadMetrics`, so ensure the existing bindings mock includes it returning an unavailable result by default.)

```ts
  it("hides cpu/mem columns and near-limit control when metrics unavailable", async () => {
    seedWorkloads([healthyRow()]); // helper used by existing tests; metricsAvailable stays false
    renderView();
    expect(screen.queryByText(/cpu/i)).toBeNull();
    expect(screen.queryByText(/near limit/i)).toBeNull();
  });

  it("shows cpu/mem columns and near-limit control when metrics available", async () => {
    seedWorkloads([healthyRow()]);
    useFleet.getState().setWorkloadUsage(useFleet.getState().workloads.cluster!, "", {
      status: { available: true, message: "", updatedAt: "t1" },
      usage: { "Deployment/ns/api": { cpuUsage: 0.18, memUsage: 470 * 1048576 } },
    });
    renderView();
    expect(screen.getAllByText(/cpu/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/near limit/i)).toBeTruthy();
  });
```

If the existing test file has no `seedWorkloads`/`healthyRow`/`renderView` helpers, add minimal local ones: a `healthyRow()` returning a `WorkloadDTO` with `resources: { cpu: { usage: null, request: 0.25, limit: 0.5 }, mem: { usage: null, request: null, limit: 536870912 } }`, `seedWorkloads(rows)` calling `useFleet.getState().setWorkloads("c", "", { fluxPresent: false, namespaces: [], workloads: rows })`, and `renderView()` rendering `<WorkloadsView cluster="c" />`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/WorkloadsView.test.tsx`
Expected: FAIL — near-limit control / cpu columns not rendered yet (and the gated test for "available" fails).

- [ ] **Step 4: Update `WorkloadsView.tsx`**

Make these changes to `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`:

1. Imports at top:

```ts
import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO, PodDTO, WorkloadKind, ResourceCellDTO } from "../store/fleet";
import { listWorkloads } from "../bridge/workloads";
import { getWorkloadMetrics } from "../bridge/workload-metrics";
import { saturation, nearLimitSort, fmtCpu, fmtMem } from "./saturation";
```

2. Add the tier→colour map and resource-cell renderer near `rankDot`:

```ts
const tierColor: Record<string, string | undefined> = {
  none: undefined, neutral: "var(--color-text-success)", warn: "var(--color-text-warning)", danger: "var(--color-text-danger)",
};

function ResourceCellView({ resource, cell, hasPods }: { resource: "cpu" | "mem"; cell: ResourceCellDTO; hasPods: boolean }) {
  const fmt = resource === "cpu" ? fmtCpu : fmtMem;
  const usage = cell.usage == null ? "—" : fmt(cell.usage);
  if (!hasPods) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  if (cell.limit == null) {
    // no calculable saturation: show usage (or —) plus muted "no limit"
    return <span>{usage} <span style={{ color: "var(--color-text-tertiary)" }}>· no limit</span></span>;
  }
  const sat = saturation(resource, cell.usage, cell.limit);
  const color = tierColor[sat.tier];
  return (
    <span style={{ color }}>{usage} / {fmt(cell.limit)}
      {sat.pct != null && (
        <span style={{ display: "inline-block", width: 46, height: 6, background: "var(--color-background-tertiary, #8883)", borderRadius: 3, verticalAlign: "middle", marginLeft: 6 }}>
          <span style={{ display: "block", width: `${Math.min(100, sat.pct * 100)}%`, height: "100%", background: color ?? "var(--color-text-success)", borderRadius: 3 }} />
        </span>
      )}
    </span>
  );
}

function riskLabel(resource: "cpu" | "mem", cell: ResourceCellDTO): string {
  const sat = saturation(resource, cell.usage, cell.limit);
  if (sat.pct == null || sat.tier === "none" || sat.tier === "neutral") return "";
  const pct = Math.round(sat.pct * 100);
  return resource === "mem" ? `· OOM risk ${pct}%` : `· throttling risk ${pct}%`;
}
```

3. In the component, read the metrics-gated flags, apply the near-limit sort, and run the lifecycle:

```ts
export function WorkloadsView({ cluster }: { cluster: string }) {
  const wl = useFleet((s) => s.workloads);
  useEffect(() => {
    listWorkloads(cluster, "").then(() => getWorkloadMetrics(cluster, ""));
    const id = setInterval(() => {
      const cur = useFleet.getState().workloads;
      if (cur.cluster === cluster) getWorkloadMetrics(cluster, cur.namespace);
    }, 30000);
    return () => { clearInterval(id); useFleet.getState().clearWorkloads(); };
  }, [cluster]);

  const onNamespace = (ns: string) => { listWorkloads(cluster, ns).then(() => getWorkloadMetrics(cluster, ns)); };
  const onRefresh = () => { listWorkloads(cluster, wl.namespace).then(() => getWorkloadMetrics(cluster, wl.namespace)); };

  const filtered = wl.items.filter((w) => wl.kindFilter[w.kind as WorkloadKind] && (!wl.needsAttention || w.rank !== "healthy"));
  const rows = wl.metricsAvailable && wl.nearLimitSort ? nearLimitSort(filtered) : filtered;
  const showMetrics = wl.metricsAvailable;
```

   Replace the namespace `<select>`'s `onChange` to call `onNamespace(e.target.value)` and the refresh button's `onClick` to call `onRefresh()`.

4. Add the "near limit" chip after the "needs attention" chip (gated):

```tsx
        <Chip on={wl.needsAttention} onClick={() => useFleet.getState().toggleNeedsAttention()}>needs attention</Chip>
        {showMetrics && (
          <Chip on={wl.nearLimitSort} onClick={() => useFleet.getState().toggleNearLimitSort()}>near limit</Chip>
        )}
```

5. Add cpu/mem to the header row and the data row, gated on `showMetrics`. Replace the grid template strings so the two columns appear only when metrics are present. Define once near the top of the render:

```ts
  const gridCols = showMetrics
    ? "12px 90px 1fr 70px 64px 1.1fr 140px 140px 130px"
    : "12px 90px 1fr 70px 64px 1.2fr 160px"; // identical to M7-c-ii-a when no metrics
```

The non-metrics value MUST stay byte-identical to the existing grid so the view is unchanged on clusters without a metrics source. Both the header `<div>` and the per-row `<div>` `gridTemplateColumns` must use `gridCols` (replace the two hard-coded `"12px 90px 1fr 70px 64px 1.2fr 160px"` literals in the current file).

   Header cells (insert `cpu`/`mem` before `gitops` when `showMetrics`):

```tsx
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>
            <span /><span>kind</span><span>workload</span><span>ready</span><span>restarts</span><span>status</span>
            {showMetrics && <span>cpu</span>}
            {showMetrics && <span>mem</span>}
            <span>gitops</span>
          </div>
```

   Data row (mirror the existing row grid; insert the two cells before the gitops cell):

```tsx
                  <span style={{ color: w.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>{w.reason}</span>
                  {showMetrics && <ResourceCellView resource="cpu" cell={w.resources.cpu} hasPods={w.pods.length > 0} />}
                  {showMetrics && <ResourceCellView resource="mem" cell={w.resources.mem} hasPods={w.pods.length > 0} />}
                  <span style={{ color: "var(--color-text-tertiary)" }} title={w.gitops ? `Flux ownership label: ${w.gitops.kind} ${w.gitops.namespace}/${w.gitops.name}` : undefined}>
                    {w.gitops ? `flux ${w.gitops.kind === "HelmRelease" ? "hr" : "ks"}/${w.gitops.name}` : "—"}
                  </span>
```

   Make sure the data row's `gridTemplateColumns` also uses `gridCols`.

6. Add the workload-level D-block to the expand, above the existing `PodTable`, gated on `showMetrics`:

```tsx
                {expanded && showMetrics && (
                  <div style={{ display: "flex", gap: 28, fontSize: 11, padding: "6px 8px 6px 32px", background: "var(--color-background-secondary)", fontFamily: "var(--font-mono)" }}>
                    <span><span style={{ color: "var(--color-text-tertiary)" }}>cpu</span> {w.pods.length === 0 ? "—" : `usage ${w.resources.cpu.usage == null ? "—" : fmtCpu(w.resources.cpu.usage)} · req ${w.resources.cpu.request == null ? "—" : fmtCpu(w.resources.cpu.request)} · ${w.resources.cpu.limit == null ? "no limit" : `lim ${fmtCpu(w.resources.cpu.limit)}`}`} <span style={{ color: "var(--color-text-warning)" }}>{riskLabel("cpu", w.resources.cpu)}</span></span>
                    <span><span style={{ color: "var(--color-text-tertiary)" }}>mem</span> {w.pods.length === 0 ? "—" : `usage ${w.resources.mem.usage == null ? "—" : fmtMem(w.resources.mem.usage)} · req ${w.resources.mem.request == null ? "—" : fmtMem(w.resources.mem.request)} · ${w.resources.mem.limit == null ? "no limit" : `lim ${fmtMem(w.resources.mem.limit)}`}`} <span style={{ color: "var(--color-text-danger)" }}>{riskLabel("mem", w.resources.mem)}</span></span>
                  </div>
                )}
                {expanded && <PodTable pods={w.pods} />}
```

- [ ] **Step 5: Run the view test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/WorkloadsView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full frontend suite + tsc**

Run: `cd cmd/klyx/frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add cmd/klyx/frontend/src/bridge/workload-metrics.ts cmd/klyx/frontend/src/cluster/WorkloadsView.tsx cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx
git commit -m "feat(ui): capability-gated cpu/mem columns, near-limit sort, expand D-block, 30s poll

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Bindings, full gate, native verification

**Files:**
- Generated: `cmd/klyx/frontend/bindings/...` (do NOT git-add — gitignored)

- [ ] **Step 1: Regenerate Wails bindings**

Run: `cd cmd/klyx && wails3 generate bindings`
Expected: `WorkloadsService.GetWorkloadMetrics` appears in the generated TS bindings. (Bindings are gitignored; never `git add` them.)

- [ ] **Step 2: Full backend gate**

Run from repo root:
```bash
go build ./... && go test ./... && go test -race ./internal/workloads/ ./internal/fleet/ ./internal/appbridge/ && go vet ./... && gofmt -l internal/ cmd/klyx/main.go
```
Expected: all PASS; `gofmt -l` prints nothing. (Benign `ld: warning ... newer macOS` lines are not errors. Ignore the `cmd/klyx/build/ios` "main undeclared" artifact.)

- [ ] **Step 3: Full frontend gate + wails build**

Run:
```bash
cd cmd/klyx/frontend && npx vitest run && npx tsc --noEmit
cd cmd/klyx && wails3 build
```
Expected: vitest all PASS; tsc clean; `wails3 build` exits 0 producing `bin/klyx`.

- [ ] **Step 4: Native homelab verification**

Apply test fixtures to the live homelab (context `kubernetes-admin@homelab-orange`; use `kubectl` with sandbox disabled), then run the app and confirm against the Workloads view. Always clean up.

```bash
kubectl create namespace klyx-test --dry-run=client -o yaml | kubectl apply -f -

# (a) Near-OOM: small mem limit + steady allocator pushing >90% (target ~92-95%).
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: memhog, namespace: klyx-test }
spec:
  replicas: 1
  selector: { matchLabels: { app: memhog } }
  template:
    metadata: { labels: { app: memhog } }
    spec:
      containers:
        - name: hog
          image: polinux/stress
          command: ["stress"]
          args: ["--vm","1","--vm-bytes","240M","--vm-hang","0"]
          resources: { requests: { memory: "256Mi", cpu: "50m" }, limits: { memory: "256Mi", cpu: "200m" } }
EOF

# (b) No limits at all.
kubectl -n klyx-test create deployment nolimit --image=registry.k8s.io/pause:3.9

# (c) No matched pods (scaled to zero).
kubectl -n klyx-test create deployment zero --image=registry.k8s.io/pause:3.9
kubectl -n klyx-test scale deployment zero --replicas=0
```

Then launch `cmd/klyx/bin/klyx` (or `task dev` / `wails3 dev` from `cmd/klyx`), go to **homelab-orange → Workloads → klyx-test**, and confirm:
- `memhog`: mem bar **red**, expand reads **OOM risk ~92%**, the **"near limit"** sort floats it to the top, and the **rank dot stays grey** (k8s health unaffected).
- `nolimit`: cpu/mem show **`· no limit`**, no bar, no %; under "near limit" it sorts **below** memhog.
- `zero`: cpu/mem show **`—`** (not "no limit").
- The **cpu/mem columns and "near limit" chip are present** (homelab-orange has Prometheus). Cross-check on a cluster without a metrics source (or temporarily): columns and chip absent, view identical to M7-c-ii-a.
- **cAdvisor cleanliness**: the cpu/mem numbers are one value per workload, not doubled. If they look doubled, add an `image!=""` matcher to `wlCPUQuery`/`wlMemQuery` in `internal/fleet/workload_metrics.go` and re-verify.

Cleanup:
```bash
kubectl delete ns klyx-test
```

- [ ] **Step 5: Final commit (if verification required a query tweak)**

If the `image!=""` matcher was needed:
```bash
git add internal/fleet/workload_metrics.go
git commit -m "fix(fleet): exclude empty-image cAdvisor series from workload usage queries

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Otherwise no commit — verification is observational. Hand off to `superpowers:finishing-a-development-branch`.

---

## Notes for the implementer

- **Honesty contract is the point.** The dangerous direction is a broken or saturated workload rendering safe, or a fake denominator. The pure tests in Tasks 1-2 and the saturation tests in Task 5 enforce it; do not weaken them to make a refactor pass.
- **Rank is never touched.** Nothing in this plan writes `w.Rank`/`rank`. The near-limit sort is a view-only re-order gated on `metricsAvailable`.
- **Reuse, don't re-match.** Usage aggregation consumes `Workload.Pods` (Assemble's join). Never re-implement pod matching in the metrics path.
- **Patch, don't replace.** `setWorkloadUsage` updates only `resources.*.usage` + status; structural rows come from `ListWorkloads`.
- **Capability-gated UI.** `metricsAvailable` flips true only on an available `GetWorkloadMetrics` response; until then (and on clusters with no source) the cpu/mem columns and near-limit chip are absent and the view is exactly M7-c-ii-a.
