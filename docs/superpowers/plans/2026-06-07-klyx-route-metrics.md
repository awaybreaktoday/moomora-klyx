# M7-b: Route latency/RPS metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render live `rps · p50 · p99 · err%` on each HTTPRoute lane of the network topology, sourced from Envoy Gateway's `envoy_cluster_*` Prometheus metrics, polled ~20s and patched in place.

**Architecture:** A pure `internal/routemetrics` package (a `Source` seam + `EnvoyClusterSource` that builds PromQL and reduces results) sits on a new `metrics.Client.InstantVector`. A fleet `(*ClusterConn).RouteMetrics` reuses the M7-a metrics transport (via an extracted `ensureMetricsLocked` helper) and gates on capability. The appbridge `GatewayService` gains `GetRouteMetrics`; the frontend polls it while a topology is open and patches numbers into the existing static topology.

**Tech Stack:** Go 1.26, client-go, `net/http`, React 19 + TS + Zustand, Vitest 4, Wails v3.

**Spec:** `docs/superpowers/specs/2026-06-07-klyx-route-metrics-design.md`

**Honesty contract (enforced across tasks):** nil ≠ 0; idle route = `0 rps` + `—` latency/err; NaN/Inf filtered in `InstantVector` before any reduction; strict `httproute/<ns>/<name>/rule/<idx>` cluster-name parser (skip, never guess); error rate summed-then-divided per route; two-level status (Prometheus capability vs Envoy route-series usability); `Message` is informational when `Available=true`.

**Metric-name gate:** the Envoy metric/label name constants (Task 4) are the documented expected forms. They live in ONE `const` block so native verification can confirm/adjust them before merge — do not scatter the strings.

---

## File structure

- `internal/metrics/vector.go` (+ `vector_test.go`) — `LabeledSample` + `Client.InstantVector`.
- `internal/routemetrics/model.go` — `RouteMetrics`, `Status`, `Source`.
- `internal/routemetrics/parse.go` (+ test) — `parseClusterName`, `buildSelector`.
- `internal/routemetrics/envoy.go` (+ test) — metric constants, `EnvoyClusterSource`, the 5 queries, the reducer, the existence probe.
- `internal/fleet/routemetrics.go` (+ test) — `ensureMetricsLocked` (extracted), `(*ClusterConn).RouteMetrics`.
- `internal/fleet/conn.go` — `RouteMetrics` on the `Conn` interface.
- `internal/fleet/metrics.go` — `ClusterMetrics` refactored to call `ensureMetricsLocked`.
- `internal/appbridge/gateway_dto.go` — route-metric DTOs.
- `internal/appbridge/gateway_service.go` — `GatewayConn.RouteMetrics` + `GatewayService.GetRouteMetrics`.
- frontend: `store/fleet.ts` (slice + types), `bridge/gateway.ts` (`getRouteMetrics`), `cluster/NetworkTopology.tsx` (lane line + caption + poller), `cluster/NetworkView.tsx` if the poller lives there.

---

## Task 1: metrics.Client.InstantVector

**Files:**
- Create: `internal/metrics/vector.go`, `internal/metrics/vector_test.go`

- [ ] **Step 1: Write the failing test**

`internal/metrics/vector_test.go`:

```go
package metrics

import (
	"context"
	"testing"
)

func TestInstantVector(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"envoy_cluster_name":"a"},"value":[1,"1.5"]},
		{"metric":{"envoy_cluster_name":"b"},"value":[1,"NaN"]},
		{"metric":{"envoy_cluster_name":"c"},"value":[1,"3"]}
	]}}`
	c := NewClient(&fakeQuerier{status: 200, body: body})
	out, err := c.InstantVector(context.Background(), "q")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// NaN element ("b") is filtered out.
	if len(out) != 2 {
		t.Fatalf("want 2 samples (NaN filtered), got %d: %+v", len(out), out)
	}
	if out[0].Labels["envoy_cluster_name"] != "a" || out[0].Value != 1.5 {
		t.Fatalf("sample 0 wrong: %+v", out[0])
	}
}

func TestInstantVectorEmptyAndErrors(t *testing.T) {
	empty := NewClient(&fakeQuerier{status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[]}}`})
	out, err := empty.InstantVector(context.Background(), "q")
	if err != nil || len(out) != 0 {
		t.Fatalf("empty vector: want 0/nil, got %d/%v", len(out), err)
	}
	notvec := NewClient(&fakeQuerier{status: 200, body: `{"status":"success","data":{"resultType":"scalar","result":[1,"1"]}}`})
	if _, err := notvec.InstantVector(context.Background(), "q"); err == nil {
		t.Fatal("want error on non-vector result")
	}
	bad := NewClient(&fakeQuerier{status: 503, body: "down"})
	if _, err := bad.InstantVector(context.Background(), "q"); err == nil {
		t.Fatal("want error on HTTP 503")
	}
}
```

(`fakeQuerier` already exists in `parse_test.go`, same package — reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/metrics/ -run InstantVector -v`
Expected: FAIL — `InstantVector` / `LabeledSample` undefined.

- [ ] **Step 3: Implement**

`internal/metrics/vector.go`:

```go
package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// LabeledSample is one element of an instant vector query result.
type LabeledSample struct {
	Labels map[string]string
	Value  float64
}

type vectorElem struct {
	Metric map[string]string `json:"metric"`
	Value  json.RawMessage   `json:"value"` // [ts, "val"]
}

// InstantVector runs an instant query expecting a vector and returns every
// element with its labels. NaN/Inf values are SKIPPED (a non-finite sample is
// "not meaningful", consistent with InstantScalar's absent handling), so they
// never reach the reducer or the DTO. An empty vector returns an empty slice
// and nil error.
func (c *Client) InstantVector(ctx context.Context, promql string) ([]LabeledSample, error) {
	status, body, err := c.q.InstantQuery(ctx, promql)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("prometheus returned HTTP %d", status)
	}
	var env promEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("not a Prometheus API response: %w", err)
	}
	if env.Status == "" {
		return nil, fmt.Errorf("not a Prometheus API response (empty status field)")
	}
	if env.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s", env.Error)
	}
	if env.Data.ResultType != "vector" {
		return nil, fmt.Errorf("expected vector result, got %q", env.Data.ResultType)
	}
	var elems []vectorElem
	if err := json.Unmarshal(env.Data.Result, &elems); err != nil {
		return nil, fmt.Errorf("parse vector: %w", err)
	}
	out := make([]LabeledSample, 0, len(elems))
	for _, e := range elems {
		v, err := parseValueTuple(e.Value)
		if errors.Is(err, errNonFinite) {
			continue // skip NaN/Inf
		}
		if err != nil {
			return nil, fmt.Errorf("parse vector value: %w", err)
		}
		out = append(out, LabeledSample{Labels: e.Metric, Value: v})
	}
	return out, nil
}
```

(Reuses `promEnvelope`, `parseValueTuple`, `errNonFinite` from `parse.go`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/metrics/ -v`
Expected: PASS (whole package).

- [ ] **Step 5: Commit**

```bash
git add internal/metrics/vector.go internal/metrics/vector_test.go
git commit -m "feat(metrics): InstantVector (labeled vector query, NaN-filtered)"
```

---

## Task 2: routemetrics model + cluster-name parser

**Files:**
- Create: `internal/routemetrics/model.go`, `internal/routemetrics/parse.go`, `internal/routemetrics/parse_test.go`

- [ ] **Step 1: Write the failing test**

`internal/routemetrics/parse_test.go`:

```go
package routemetrics

import "testing"

func TestParseClusterName(t *testing.T) {
	cases := []struct {
		in      string
		wantKey string
		wantOK  bool
	}{
		{"httproute/default/web/rule/0", "default/web", true},
		{"httproute/team-a/api-gw/rule/12", "team-a/api-gw", true},
		{"httproute/default/web", "", false},          // no rule segment
		{"httproute/default/web/rule/foo", "", false}, // non-numeric rule
		{"httproute/default/web/rule/", "", false},    // empty rule idx
		{"httproute//web/rule/0", "", false},          // empty namespace
		{"cluster/default/web/rule/0", "", false},     // wrong prefix
		{"httproute/default/web/route/0", "", false},  // wrong segment
		{"", "", false},
	}
	for _, tc := range cases {
		k, ok := parseClusterName(tc.in)
		if ok != tc.wantOK || k != tc.wantKey {
			t.Fatalf("parseClusterName(%q) = (%q,%v), want (%q,%v)", tc.in, k, ok, tc.wantKey, tc.wantOK)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/routemetrics/ -run ParseClusterName -v`
Expected: FAIL — package/function undefined.

- [ ] **Step 3: Implement**

`internal/routemetrics/model.go`:

```go
// Package routemetrics builds per-route traffic metrics (rps/p50/p99/err) for
// the network topology from a metrics source. EnvoyClusterSource is the only
// implementation; Cilium/Hubble can implement Source later.
package routemetrics

import (
	"context"
	"time"
)

// RouteMetrics is the per-route traffic readout. A nil pointer means "no usable
// value" (no series, or not meaningful e.g. latency/err at zero traffic) and
// renders "—"; it is never a fabricated 0. ErrRate is a FRACTION in [0,1].
type RouteMetrics struct {
	RPS     *float64
	P50     *float64 // milliseconds
	P99     *float64 // milliseconds
	ErrRate *float64 // fraction 0..1
}

// Status reports whether route metrics are usable for a topology, separate from
// the M7-a Prometheus capability. Message is the unavailable reason when
// Available is false, OR an informational note when Available is true (e.g.
// "no route series matched this topology").
type Status struct {
	Available bool
	Message   string
	UpdatedAt time.Time
}

// Source produces per-route metrics for a set of route keys ("<ns>/<name>").
type Source interface {
	QueryRouteMetrics(ctx context.Context, routeKeys []string) (map[string]RouteMetrics, Status, error)
}
```

`internal/routemetrics/parse.go`:

```go
package routemetrics

import "strings"

// parseClusterName extracts "<ns>/<name>" from an Envoy cluster name of the
// exact form httproute/<ns>/<name>/rule/<number>. Any other shape returns
// ok=false (skip, never guess). K8s namespaces/names cannot contain "/", so a
// 5-segment split is unambiguous.
func parseClusterName(name string) (routeKey string, ok bool) {
	parts := strings.Split(name, "/")
	if len(parts) != 5 {
		return "", false
	}
	if parts[0] != "httproute" || parts[3] != "rule" {
		return "", false
	}
	if parts[1] == "" || parts[2] == "" || !isAllDigits(parts[4]) {
		return "", false
	}
	return parts[1] + "/" + parts[2], true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/routemetrics/ -run ParseClusterName -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/routemetrics/model.go internal/routemetrics/parse.go internal/routemetrics/parse_test.go
git commit -m "feat(routemetrics): model + strict envoy cluster-name parser"
```

---

## Task 3: routemetrics selector builder

**Files:**
- Modify: `internal/routemetrics/parse.go`
- Test: `internal/routemetrics/parse_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/routemetrics/parse_test.go`:

```go
import "regexp" // add to the existing import block

func TestBuildSelector(t *testing.T) {
	if got := buildSelector(nil); got != "" {
		t.Fatalf("empty keys should give empty selector, got %q", got)
	}
	sel := buildSelector([]string{"default/web", "team.a/api-gw"})
	// anchored, alternation, regex-escaped (the dot in "team.a" must be escaped).
	want := `envoy_cluster_name=~"^httproute/(default/web|team\.a/api\-gw)/rule/[0-9]+$"`
	if sel != want {
		t.Fatalf("buildSelector:\n got %s\nwant %s", sel, want)
	}
	// the alternation body is a valid regex.
	inner := `^httproute/(default/web|team\.a/api\-gw)/rule/[0-9]+$`
	if _, err := regexp.Compile(inner); err != nil {
		t.Fatalf("selector regex does not compile: %v", err)
	}
}
```

Note: `regexp.QuoteMeta("team.a/api-gw")` yields `team\.a/api\-gw` (it escapes `.` and `-`; `/` is not a metachar). If Go's QuoteMeta output differs for `-` in your version, adjust the `want` literal to match `regexp.QuoteMeta` output exactly — the test's intent is "escaped + anchored", not a specific escape style.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/routemetrics/ -run BuildSelector -v`
Expected: FAIL — `buildSelector` undefined.

- [ ] **Step 3: Implement**

Append to `internal/routemetrics/parse.go`:

```go
import (
	"regexp"
	"strings"
)

// buildSelector builds the anchored, regex-escaped envoy_cluster_name matcher
// for a set of route keys ("<ns>/<name>"). Returns "" for empty input (the
// caller must guard and not query with an empty alternation).
func buildSelector(routeKeys []string) string {
	if len(routeKeys) == 0 {
		return ""
	}
	alts := make([]string, 0, len(routeKeys))
	for _, k := range routeKeys {
		alts = append(alts, regexp.QuoteMeta(k))
	}
	return `envoy_cluster_name=~"^httproute/(` + strings.Join(alts, "|") + `)/rule/[0-9]+$"`
}
```

(Merge the `import` with the existing `strings` import in `parse.go` — one import block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/routemetrics/ -v`
Expected: PASS. If the `want` literal mismatched QuoteMeta's exact escaping, fix the literal to match the actual output (run the test, read the diff, paste the `got`).

- [ ] **Step 5: Commit**

```bash
git add internal/routemetrics/parse.go internal/routemetrics/parse_test.go
git commit -m "feat(routemetrics): anchored regex-escaped route-key selector"
```

---

## Task 4: EnvoyClusterSource (queries + reducer + status)

**Files:**
- Create: `internal/routemetrics/envoy.go`, `internal/routemetrics/envoy_test.go`

- [ ] **Step 1: Write the failing test**

`internal/routemetrics/envoy_test.go`:

```go
package routemetrics

import (
	"context"
	"strings"
	"testing"

	"github.com/moomora/klyx/internal/metrics"
)

const emptyVec = `{"status":"success","data":{"resultType":"vector","result":[]}}`

func vec(elems string) string {
	return `{"status":"success","data":{"resultType":"vector","result":[` + elems + `]}}`
}
func el(cluster, val string) string {
	return `{"metric":{"envoy_cluster_name":"` + cluster + `"},"value":[1,"` + val + `"]}`
}

// scriptedVecQ answers each of the 5 route queries (plus the existence probe)
// by a DETERMINISTIC ordered match. Order matters: the 5xx query string also
// contains "upstream_rq_xx", so the class="5" case MUST be checked first.
type scriptedVecQ struct {
	rqTotal, p50, p99, rq5xx, rqAll, count string
}

func (q *scriptedVecQ) InstantQuery(_ context.Context, promql string) (int, []byte, error) {
	pick := func(s string) (int, []byte, error) {
		if s == "" {
			s = emptyVec
		}
		return 200, []byte(s), nil
	}
	switch {
	case strings.Contains(promql, "count("):
		return pick(q.count)
	case strings.Contains(promql, `envoy_response_code_class="5"`):
		return pick(q.rq5xx)
	case strings.Contains(promql, "upstream_rq_xx"):
		return pick(q.rqAll)
	case strings.Contains(promql, "upstream_rq_total"):
		return pick(q.rqTotal)
	case strings.Contains(promql, "histogram_quantile(0.50"):
		return pick(q.p50)
	case strings.Contains(promql, "histogram_quantile(0.99"):
		return pick(q.p99)
	}
	return pick(emptyVec)
}

func TestEnvoyClusterSource_MultiRuleAndIdle(t *testing.T) {
	q := &scriptedVecQ{
		// rps: web has two rules (sum=12.0+0.4=12.4); api idle (0)
		rqTotal: vec(el("httproute/default/web/rule/0", "12.0") + "," + el("httproute/default/web/rule/1", "0.4") + "," + el("httproute/default/api/rule/0", "0")),
		// p99 across web rules: 42 and 50 -> route p99 = max = 50
		p99: vec(el("httproute/default/web/rule/0", "42") + "," + el("httproute/default/web/rule/1", "50")),
		p50: vec(el("httproute/default/web/rule/0", "8") + "," + el("httproute/default/web/rule/1", "9")),
		// err: 5xx across rules = 0.03+0.01 = 0.04; all = 10.0+2.4 = 12.4 -> 0.04/12.4 ~ 0.00323
		rq5xx: vec(el("httproute/default/web/rule/0", "0.03") + "," + el("httproute/default/web/rule/1", "0.01")),
		rqAll: vec(el("httproute/default/web/rule/0", "10.0") + "," + el("httproute/default/web/rule/1", "2.4")),
	}
	out, st, err := NewEnvoyClusterSource(metrics.NewClient(q)).QueryRouteMetrics(context.Background(), []string{"default/web", "default/api"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !st.Available {
		t.Fatalf("want available, got %+v", st)
	}
	web, ok := out["default/web"]
	if !ok || web.RPS == nil || *web.RPS != 12.4 {
		t.Fatalf("web rps want 12.4, got %+v", web.RPS)
	}
	if web.P99 == nil || *web.P99 != 50 {
		t.Fatalf("web p99 want 50 (max across rules), got %+v", web.P99)
	}
	if web.ErrRate == nil || *web.ErrRate < 0.0031 || *web.ErrRate > 0.0034 {
		t.Fatalf("web err want ~0.00323 (0.04/12.4), got %+v", web.ErrRate)
	}
	api, ok := out["default/api"]
	if !ok || api.RPS == nil || *api.RPS != 0 {
		t.Fatalf("api should be present with rps 0 (idle), got %+v", api)
	}
	if api.P50 != nil || api.P99 != nil || api.ErrRate != nil {
		t.Fatalf("api idle latency/err must be nil, got %+v", api)
	}
}

func TestEnvoyClusterSource_NoSeriesVsNoMatch(t *testing.T) {
	// All scoped queries empty (zero-value scriptedVecQ). Existence probe decides.
	noSeries := &scriptedVecQ{count: emptyVec} // count of nothing -> empty vector
	_, st, err := NewEnvoyClusterSource(metrics.NewClient(noSeries)).QueryRouteMetrics(context.Background(), []string{"default/web"})
	if err != nil || st.Available || !strings.Contains(st.Message, "no envoy_cluster_* series") {
		t.Fatalf("no-series: want unavailable + reason, got %+v / %v", st, err)
	}

	noMatch := &scriptedVecQ{count: vec(el("", "5"))} // series exist (count=5) but none matched
	_, st2, err := NewEnvoyClusterSource(metrics.NewClient(noMatch)).QueryRouteMetrics(context.Background(), []string{"default/web"})
	if err != nil || !st2.Available || !strings.Contains(st2.Message, "no route series matched") {
		t.Fatalf("no-match: want available + note, got %+v / %v", st2, err)
	}
}

func TestEnvoyClusterSource_EmptyKeys(t *testing.T) {
	out, st, err := NewEnvoyClusterSource(metrics.NewClient(&scriptedVecQ{})).QueryRouteMetrics(context.Background(), nil)
	if err != nil || !st.Available || len(out) != 0 {
		t.Fatalf("empty keys: want available empty, got %+v %+v %v", out, st, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/routemetrics/ -run EnvoyClusterSource -v`
Expected: FAIL — `EnvoyClusterSource` undefined.

- [ ] **Step 3: Implement**

`internal/routemetrics/envoy.go`:

```go
package routemetrics

import (
	"context"
	"fmt"

	"github.com/moomora/klyx/internal/metrics"
)

// Envoy metric and label names. SINGLE source of truth — native verification
// confirms/adjusts these before merge (see the spec's hard gate). Do not
// inline these strings elsewhere.
const (
	mRqTotal     = "envoy_cluster_upstream_rq_total"
	mRqTime      = "envoy_cluster_upstream_rq_time_bucket"
	mRqXX        = "envoy_cluster_upstream_rq_xx"
	lClusterName = "envoy_cluster_name"
	lRespClass   = "envoy_response_code_class"
	rateWindow   = "5m"
)

// EnvoyClusterSource builds Envoy-cluster PromQL and reduces the result into
// per-route metrics. Pure of clocks; the fleet layer stamps Status.UpdatedAt.
type EnvoyClusterSource struct{ client *metrics.Client }

func NewEnvoyClusterSource(c *metrics.Client) *EnvoyClusterSource {
	return &EnvoyClusterSource{client: c}
}

func (s *EnvoyClusterSource) QueryRouteMetrics(ctx context.Context, routeKeys []string) (map[string]RouteMetrics, Status, error) {
	if len(routeKeys) == 0 {
		return map[string]RouteMetrics{}, Status{Available: true}, nil
	}
	sel := buildSelector(routeKeys)

	rps, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s}[%s]))", lClusterName, mRqTotal, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	p50, err := s.client.InstantVector(ctx, fmt.Sprintf("histogram_quantile(0.50, sum by (%s, le)(rate(%s{%s}[%s])))", lClusterName, mRqTime, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	p99, err := s.client.InstantVector(ctx, fmt.Sprintf("histogram_quantile(0.99, sum by (%s, le)(rate(%s{%s}[%s])))", lClusterName, mRqTime, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	rq5xx, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s,%s=\"5\"}[%s]))", lClusterName, mRqXX, sel, lRespClass, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	rqall, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s}[%s]))", lClusterName, mRqXX, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}

	out := reduce(rps, p50, p99, rq5xx, rqall)
	if len(out) > 0 {
		return out, Status{Available: true}, nil
	}

	// No matched series: distinguish "Envoy not scraped at all" from "these
	// routes are just idle / mislabeled". Reuse the verified rq-total constant.
	exist, err := s.client.InstantScalar(ctx, fmt.Sprintf("count(%s)", mRqTotal))
	if err != nil {
		return nil, Status{}, err
	}
	if exist.Absent || exist.Value == 0 {
		return out, Status{Available: false, Message: "no envoy_cluster_* series found"}, nil
	}
	return out, Status{Available: true, Message: "no route series matched this topology"}, nil
}

type acc struct {
	rps    float64
	rpsHas bool
	p50    float64
	p50Has bool
	p99    float64
	p99Has bool
	f5xx   float64
	fall   float64
	fallHas bool
}

// reduce maps per-rule vector elements to per-route metrics: rps summed across
// rules; p50/p99 max across rules (worst-rule tail); err = sum(5xx)/sum(all)
// divided ONCE per route (never averaging per-rule fractions). A route is
// "measured" iff it has an rps element (the counter exists even at 0 traffic).
func reduce(rps, p50, p99, rq5xx, rqall []metrics.LabeledSample) map[string]RouteMetrics {
	accs := map[string]*acc{}
	get := func(k string) *acc {
		a := accs[k]
		if a == nil {
			a = &acc{}
			accs[k] = a
		}
		return a
	}
	for _, s := range rps {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			a.rps += s.Value
			a.rpsHas = true
		}
	}
	for _, s := range p50 {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			if !a.p50Has || s.Value > a.p50 {
				a.p50 = s.Value
				a.p50Has = true
			}
		}
	}
	for _, s := range p99 {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			if !a.p99Has || s.Value > a.p99 {
				a.p99 = s.Value
				a.p99Has = true
			}
		}
	}
	for _, s := range rq5xx {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			get(k).f5xx += s.Value
		}
	}
	for _, s := range rqall {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			a.fall += s.Value
			a.fallHas = true
		}
	}

	out := make(map[string]RouteMetrics, len(accs))
	for k, a := range accs {
		if !a.rpsHas {
			continue // not measured without an rps series
		}
		rm := RouteMetrics{}
		v := a.rps
		rm.RPS = &v
		if a.p50Has {
			p := a.p50
			rm.P50 = &p
		}
		if a.p99Has {
			p := a.p99
			rm.P99 = &p
		}
		if a.fallHas && a.fall > 0 {
			e := a.f5xx / a.fall
			rm.ErrRate = &e
		}
		out[k] = rm
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/routemetrics/ -v`
Expected: PASS (all of Task 2/3/4). If a query-disambiguation substring in the test collides (5xx vs all both contain `rq_xx`), confirm the source's err query includes `envoy_response_code_class="5"` so the test's `bySubstr` keys are distinguishable — they are, as written.

- [ ] **Step 5: Commit**

```bash
git add internal/routemetrics/envoy.go internal/routemetrics/envoy_test.go
git commit -m "feat(routemetrics): EnvoyClusterSource — 5 grouped queries, rule reducer, status"
```

---

## Task 5: fleet RouteMetrics (+ extract ensureMetricsLocked)

**Files:**
- Create: `internal/fleet/routemetrics.go`, `internal/fleet/routemetrics_test.go`
- Modify: `internal/fleet/metrics.go` (extract `ensureMetricsLocked`), `internal/fleet/conn.go` (interface)

- [ ] **Step 1: Extract `ensureMetricsLocked` from `ClusterMetrics`**

In `internal/fleet/metrics.go`, replace the body of `ClusterMetrics` so the
resolve/probe block becomes a reusable helper. The current `ClusterMetrics`
(lines ~101-148) holds `metricsMu`, computes `now`, runs the capValid/resolve
block inline, then the sample cache. Refactor to:

```go
// ensureMetricsLocked resolves+probes the metrics endpoint into c.metricsState
// when the cached capability is invalid. Caller MUST hold c.metricsMu.
func (c *ClusterConn) ensureMetricsLocked(ctx context.Context, forceReprobe bool, now time.Time) {
	capValid := c.metricsState.capSet && !forceReprobe &&
		(c.metricsState.cap.Available || now.Before(c.metricsState.capExpiry))
	if capValid {
		return
	}
	var tf metrics.TransportFactory = transportFactory{rest: c.typed.CoreV1().RESTClient()}
	if c.metricsTF != nil {
		tf = c.metricsTF
	}
	disco := metrics.DiscoveryResult{}
	if c.metricsCfg.Endpoint == "" && c.metricsCfg.ServiceRef == nil {
		disco = c.discover(ctx)
	}
	res := metrics.Resolve(c.metricsCfg, disco, tf)
	cap := metrics.Probe(ctx, res)

	c.metricsState.capSet = true
	c.metricsState.cap = cap
	c.metricsState.transport = res.Transport
	if cap.Available {
		c.metricsState.capExpiry = time.Time{}
	} else {
		c.metricsState.capExpiry = now.Add(metricsUnavailableTTL)
	}
	c.metricsState.samples = metrics.ClusterMetrics{}
	c.metricsState.samplesExp = time.Time{}
}

func (c *ClusterConn) ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability) {
	c.metricsMu.Lock()
	defer c.metricsMu.Unlock()

	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	now := clk.Now()
	c.ensureMetricsLocked(ctx, forceReprobe, now)

	cap := c.metricsState.cap
	if !cap.Available {
		return metrics.ClusterMetrics{}, cap
	}
	if c.metricsState.samplesExp.IsZero() || now.After(c.metricsState.samplesExp) {
		c.metricsState.samples = querySamples(ctx, c.metricsState.transport)
		c.metricsState.samplesExp = now.Add(metricsSampleTTL)
	}
	return c.metricsState.samples, cap
}
```

- [ ] **Step 2: Verify the refactor is behavior-preserving**

Run: `go test ./internal/fleet/ -run 'ClusterMetrics|Discover' -v && go test -race ./internal/fleet/`
Expected: PASS (the M7-a metrics tests are unchanged and still green).

- [ ] **Step 3: Write the failing test for `RouteMetrics`**

`internal/fleet/routemetrics_test.go`:

```go
package fleet

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/metrics"
	"k8s.io/client-go/kubernetes/fake"
)

func TestRouteMetricsEmptyKeys(t *testing.T) {
	c := &ClusterConn{typed: fake.NewSimpleClientset(), clk: clock.NewFake(time.Unix(0, 0))}
	m, st := c.RouteMetrics(context.Background(), nil)
	if !st.Available || len(m) != 0 {
		t.Fatalf("empty keys: want available empty, got %+v %+v", m, st)
	}
}

func TestRouteMetricsGateEnvoyAbsent(t *testing.T) {
	c := &ClusterConn{typed: fake.NewSimpleClientset(), clk: clock.NewFake(time.Unix(0, 0))}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: false}}
	_, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if st.Available || st.Message != "Envoy Gateway not detected" {
		t.Fatalf("want envoy-not-detected, got %+v", st)
	}
}

func TestRouteMetricsGateMetricsUnavailable(t *testing.T) {
	// Envoy present, but no metrics endpoint/serviceRef and no discoverable svc
	// -> metrics capability unavailable -> route metrics unavailable with reason.
	c := &ClusterConn{
		typed:      fake.NewSimpleClientset(),
		clk:        clock.NewFake(time.Unix(0, 0)),
		metricsCfg: config.MetricsConfig{},
	}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: true}}
	_, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if st.Available || st.Message == "" {
		t.Fatalf("want metrics-unavailable reason, got %+v", st)
	}
}

func TestRouteMetricsHappy(t *testing.T) {
	// Envoy present + injected metrics transport returning route series.
	clk := clock.NewFake(time.Unix(100, 0))
	q := &fleetVecQ{} // returns a web rps series for any rq_total query
	c := &ClusterConn{
		typed:      fake.NewSimpleClientset(),
		clk:        clk,
		metricsCfg: config.MetricsConfig{Endpoint: "http://prom"},
		metricsTF:  fakeTF{q: q},
	}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: true}}
	m, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if !st.Available {
		t.Fatalf("want available, got %+v", st)
	}
	if st.UpdatedAt != clk.Now() {
		t.Fatalf("UpdatedAt should be stamped to now, got %v", st.UpdatedAt)
	}
	if rm, ok := m["default/web"]; !ok || rm.RPS == nil {
		t.Fatalf("want web rps, got %+v", m)
	}
}
```

Add a `fleetVecQ` helper to this file: it must answer the liveness probe
(`vector(1)` → 1) AND the route queries. Reuse the `fakeTF` from
`metrics_test.go` (same package). Minimal:

```go
type fleetVecQ struct{}

func (fleetVecQ) InstantQuery(_ context.Context, promql string) (int, []byte, error) {
	switch {
	case contains(promql, "vector(1)"):
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[{"value":[1,"1"]}]}}`), nil
	case contains(promql, "upstream_rq_total"):
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"envoy_cluster_name":"httproute/default/web/rule/0"},"value":[1,"3.5"]}]}}`), nil
	default: // latency / rq_xx -> empty vector
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`), nil
	}
}
func contains(s, sub string) bool { return strings.Contains(s, sub) }
```

(Add `"strings"` to the test imports. `fakeTF` already exists in
`metrics_test.go`.)

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run RouteMetrics -v`
Expected: FAIL — `RouteMetrics` undefined.

- [ ] **Step 5: Implement `RouteMetrics` + interface**

`internal/fleet/routemetrics.go`:

```go
package fleet

import (
	"context"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/metrics"
	"github.com/moomora/klyx/internal/routemetrics"
)

// RouteMetrics returns per-route traffic metrics for the given route keys
// ("<ns>/<name>") plus an Envoy-route-series status (distinct from the M7-a
// Prometheus capability). On-demand; reuses the cached metrics transport.
func (c *ClusterConn) RouteMetrics(ctx context.Context, routeKeys []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	now := clk.Now()

	if len(routeKeys) == 0 {
		return map[string]routemetrics.RouteMetrics{}, routemetrics.Status{Available: true, UpdatedAt: now}
	}

	c.mu.RLock()
	hasEnvoy := c.caps.Network.HasEnvoyProxy
	c.mu.RUnlock()
	if !hasEnvoy {
		return nil, routemetrics.Status{Available: false, Message: "Envoy Gateway not detected"}
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
		return nil, routemetrics.Status{Available: false, Message: msg}
	}

	src := routemetrics.NewEnvoyClusterSource(metrics.NewClient(transport))
	out, st, err := src.QueryRouteMetrics(ctx, routeKeys)
	if err != nil {
		return nil, routemetrics.Status{Available: false, Message: "route metrics query failed: " + err.Error()}
	}
	st.UpdatedAt = now // fleet stamps freshness on a produced result
	return out, st
}
```

In `internal/fleet/conn.go`, add to the `Conn` interface (and the
`"github.com/moomora/klyx/internal/routemetrics"` import):

```go
	RouteMetrics(ctx context.Context, routeKeys []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status)
```

The `fakeConn` stub in `internal/fleet/registry_test.go` must gain this method to
keep satisfying `Conn`:

```go
func (fakeConn) RouteMetrics(context.Context, []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	return nil, routemetrics.Status{}
}
```
(Import `routemetrics` in `registry_test.go`.)

- [ ] **Step 6: Run tests + race**

Run: `go test ./internal/fleet/ -run RouteMetrics -v && go test -race ./internal/fleet/ ./internal/routemetrics/ ./internal/metrics/`
Expected: PASS, no races.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/routemetrics.go internal/fleet/routemetrics_test.go internal/fleet/metrics.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): RouteMetrics — gated, reuses metrics transport via ensureMetricsLocked"
```

---

## Task 6: appbridge GetRouteMetrics + DTOs

**Files:**
- Modify: `internal/appbridge/gateway_dto.go`, `internal/appbridge/gateway_service.go`
- Test: `internal/appbridge/gateway_service_test.go` (or a new `gateway_routemetrics_test.go`)

- [ ] **Step 1: Write the failing test**

Create `internal/appbridge/gateway_routemetrics_test.go`:

```go
package appbridge

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gwapi"
	"github.com/moomora/klyx/internal/routemetrics"
)

type fakeRMConn struct {
	m  map[string]routemetrics.RouteMetrics
	st routemetrics.Status
}

func (f fakeRMConn) ListGateways(context.Context) ([]gwapi.GatewayRef, bool, error) { return nil, false, nil }
func (f fakeRMConn) GetGatewayTopology(context.Context, string, string) (gwapi.Topology, error) {
	return gwapi.Topology{}, nil
}
func (f fakeRMConn) RouteMetrics(context.Context, []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	return f.m, f.st
}

func TestGetRouteMetrics(t *testing.T) {
	t.Run("cluster miss -> unavailable", func(t *testing.T) {
		s := NewGatewayService(func(string) (GatewayConn, bool) { return nil, false })
		dto := s.GetRouteMetrics("nope", []string{"default/web"})
		if dto.Status.Available {
			t.Fatalf("got %+v", dto)
		}
		if dto.Routes == nil {
			t.Fatal("Routes must be non-nil (JSON {})")
		}
	})
	t.Run("maps metrics + status + updatedAt", func(t *testing.T) {
		rps := 12.4
		conn := fakeRMConn{
			m:  map[string]routemetrics.RouteMetrics{"default/web": {RPS: &rps}},
			st: routemetrics.Status{Available: true, UpdatedAt: time.Unix(100, 0)},
		}
		s := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
		dto := s.GetRouteMetrics("c", []string{"default/web"})
		if !dto.Status.Available || dto.Status.UpdatedAt == "" {
			t.Fatalf("status: %+v", dto.Status)
		}
		if dto.Routes["default/web"].RPS == nil || *dto.Routes["default/web"].RPS != 12.4 {
			t.Fatalf("routes: %+v", dto.Routes)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run GetRouteMetrics -v`
Expected: FAIL — `GetRouteMetrics`/DTOs undefined; `GatewayConn` lacks `RouteMetrics`.

- [ ] **Step 3: Implement DTOs + the extended interface + the method**

Append to `internal/appbridge/gateway_dto.go`:

```go
// RouteMetricDTO is a route's traffic readout. Nil fractions serialize as JSON
// null (UI renders "—"), never 0. ErrRate is a fraction 0..1.
type RouteMetricDTO struct {
	RPS     *float64 `json:"rps"`
	P50     *float64 `json:"p50"` // ms
	P99     *float64 `json:"p99"` // ms
	ErrRate *float64 `json:"errRate"`
}

type RouteMetricsStatusDTO struct {
	Available bool   `json:"available"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updatedAt"` // RFC3339; "" when never succeeded
}

type RouteMetricsResultDTO struct {
	Status RouteMetricsStatusDTO     `json:"status"`
	Routes map[string]RouteMetricDTO `json:"routes"`
}
```

In `internal/appbridge/gateway_service.go`, extend `GatewayConn` and add the
method (and the `"github.com/moomora/klyx/internal/routemetrics"` import):

```go
type GatewayConn interface {
	ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error)
	GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error)
	RouteMetrics(ctx context.Context, routeKeys []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status)
}

// GetRouteMetrics returns per-route traffic metrics + an Envoy-route status for
// the given route keys ("<ns>/<name>"). On-demand; the frontend polls it.
func (s *GatewayService) GetRouteMetrics(cluster string, routeKeys []string) RouteMetricsResultDTO {
	empty := RouteMetricsResultDTO{Routes: map[string]RouteMetricDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		empty.Status = RouteMetricsStatusDTO{Available: false, Message: "cluster not connected"}
		return empty
	}
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTimeout)
	defer cancel()
	m, st := conn.RouteMetrics(ctx, routeKeys)
	routes := make(map[string]RouteMetricDTO, len(m))
	for k, rm := range m {
		routes[k] = RouteMetricDTO{RPS: rm.RPS, P50: rm.P50, P99: rm.P99, ErrRate: rm.ErrRate}
	}
	updatedAt := ""
	if !st.UpdatedAt.IsZero() {
		updatedAt = st.UpdatedAt.Format(time.RFC3339)
	}
	return RouteMetricsResultDTO{
		Status: RouteMetricsStatusDTO{Available: st.Available, Message: st.Message, UpdatedAt: updatedAt},
		Routes: routes,
	}
}
```

Note: any OTHER fake implementing `GatewayConn` in appbridge tests (e.g. in
`gateway_service_test.go`) now needs a `RouteMetrics` stub. Find them
(`grep -rn "GetGatewayTopology" internal/appbridge/*_test.go`) and add:
```go
func (f <fakeType>) RouteMetrics(context.Context, []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	return nil, routemetrics.Status{}
}
```

- [ ] **Step 4: Run test + build**

Run: `go test ./internal/appbridge/ -v && go build ./internal/...`
Expected: PASS; clean build (confirms `fleet.Conn` still satisfies the extended `appbridge.GatewayConn` — it gained `RouteMetrics` in Task 5).

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gateway_dto.go internal/appbridge/gateway_service.go internal/appbridge/gateway_routemetrics_test.go internal/appbridge/gateway_service_test.go
git commit -m "feat(appbridge): GatewayService.GetRouteMetrics + route-metric DTOs"
```

---

## Task 7: Frontend — store, bridge, poller, lane rendering; bindings + full verify

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/bridge/gateway.ts`, `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`
- Test: `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

**Context:** The route lane is rendered in `NetworkTopology.tsx`; each route's
key is `routeKey(r)` (= `"<ns>/<name>"`). `net.selectedRoute` already holds that
key. The cluster name is on the route state (`route.cluster`). The metrics line
attaches under the route box (after its policy chips, ~line 127). A topology
caption goes near the existing global-services caption (~line 161).

- [ ] **Step 1: Add the store slice + types**

In `cmd/klyx/frontend/src/store/fleet.ts`, add types near the topology DTOs:

```ts
export type RouteMetricDTO = { rps: number | null; p50: number | null; p99: number | null; errRate: number | null };
export type RouteMetricsStatusDTO = { available: boolean; message: string; updatedAt: string };
export type RouteMetricsResultDTO = { status: RouteMetricsStatusDTO; routes: Record<string, RouteMetricDTO> };
```

Extend the `NetworkSlice` type with:
```ts
  routeMetrics: Record<string, RouteMetricDTO>;
  routeMetricsStatus: RouteMetricsStatusDTO | null;
  routeMetricsStale: boolean;
```
And add to `FleetState`:
```ts
  setRouteMetrics: (result: RouteMetricsResultDTO) => void;
```
In the store body, initialize the network slice's new fields (`routeMetrics: {}`,
`routeMetricsStatus: null`, `routeMetricsStale: false`) and add the setter with
the **preserve-last-good** behavior:

```ts
  setRouteMetrics: (result) =>
    set((s) => {
      if (result.status.available) {
        // fresh good data: replace numbers, clear stale
        return { network: { ...s.network, routeMetrics: result.routes ?? {}, routeMetricsStatus: result.status, routeMetricsStale: false } };
      }
      // transient failure: keep last good numbers + last good updatedAt, mark stale
      const prevStatus = s.network.routeMetricsStatus;
      const keptUpdatedAt = prevStatus?.updatedAt ?? "";
      return {
        network: {
          ...s.network,
          // keep s.network.routeMetrics as-is (do NOT blank to {})
          routeMetricsStatus: { ...result.status, updatedAt: keptUpdatedAt },
          routeMetricsStale: Object.keys(s.network.routeMetrics).length > 0,
        },
      };
    }),
```
Also ensure `clearNetwork` (and gateway-change) resets `routeMetrics: {}`,
`routeMetricsStatus: null`, `routeMetricsStale: false` so a new gateway starts clean.

- [ ] **Step 2: Add the bridge call**

In `cmd/klyx/frontend/src/bridge/gateway.ts` (copy the `GatewayService` import
already at the top of that file):

```ts
import { useFleet, GatewayListDTO, TopologyDTO, GatewayRef, RouteMetricsResultDTO } from "../store/fleet";
// ... existing imports ...

export async function getRouteMetrics(cluster: string, routeKeys: string[]): Promise<void> {
  const r = (await GatewayService.GetRouteMetrics(cluster, routeKeys)) as RouteMetricsResultDTO;
  useFleet.getState().setRouteMetrics(r ?? { status: { available: false, message: "", updatedAt: "" }, routes: {} });
}
```

- [ ] **Step 3: Write the failing render test**

Add cases to `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` (read the
file first for the existing topology fixture + render harness; reuse them). Mock
the bridge so the poller does not hit a real binding:

```tsx
vi.mock("../bridge/gateway", async (orig) => ({ ...(await orig()), getRouteMetrics: vi.fn() }));

// In a test, set a topology with one route "default/web", then:
useFleet.setState((s) => ({ network: { ...s.network,
  routeMetrics: { "default/web": { rps: 12.4, p50: 8, p99: 42, errRate: 0.003 } },
  routeMetricsStatus: { available: true, message: "", updatedAt: new Date().toISOString() },
  routeMetricsStale: false } }));
// assert the lane shows "12.4 rps", "p99 42ms", and an "err" figure.

// Second test: a route with no entry renders "0 rps"? No — no entry = all "—".
// Set routeMetrics: { "default/web": { rps: 0, p50: null, p99: null, errRate: null } }
// assert "0 rps" present and "p50 —" present.

// Third test: status unavailable -> caption "route metrics unavailable: <message>".
```

Write three concrete `it(...)` blocks asserting: (a) populated numbers render;
(b) idle route shows `0 rps` + `p50 —`/`p99 —`/`err —`; (c) `status.available:false`
with a message renders the caption text. Use the file's existing render helper
and route fixture; only the assertions above are new.

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx`
Expected: FAIL (no metrics rendered yet).

- [ ] **Step 4: Render the metrics line + caption + poller**

In `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`:

(a) Read the metrics slice + a small formatter. Near the top of the component:
```tsx
const routeMetrics = useFleet((s) => s.network.routeMetrics);
const rmStatus = useFleet((s) => s.network.routeMetricsStatus);
const rmStale = useFleet((s) => s.network.routeMetricsStale);
const cluster = useFleet((s) => (s.route.name === "cluster" ? s.route.cluster : ""));
```

(b) The poller — fires on (cluster, gateway, route set) and every 20s:
```tsx
const routeKeysJoined = t.routes.map(routeKey).join(",");
useEffect(() => {
  if (!cluster || t.routes.length === 0) return;
  const keys = routeKeysJoined ? routeKeysJoined.split(",") : [];
  let alive = true;
  const tick = () => { if (alive) getRouteMetrics(cluster, keys); };
  tick();
  const id = setInterval(tick, 20000);
  return () => { alive = false; clearInterval(id); };
}, [cluster, routeKeysJoined]);
```
(Import `useEffect` and `getRouteMetrics`. `t` is the topology already in scope.)

(c) The lane line — inside the route box, after the policy chips block (~line 127),
add:
```tsx
<RouteMetricsLine m={routeMetrics[routeKey(r)]} />
```
and define the component (with the helpers) at the bottom of the file:
```tsx
function fmtMs(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}
function fmtRps(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}`;
}
function fmtErr(v: number | null): string {
  if (v == null) return "—";
  const pct = v * 100;
  return pct > 0 && pct < 0.1 ? "<0.1%" : `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
}
function RouteMetricsLine({ m }: { m: import("../store/fleet").RouteMetricDTO | undefined }) {
  const rps = m?.rps ?? null, p50 = m?.p50 ?? null, p99 = m?.p99 ?? null, err = m?.errRate ?? null;
  const errColor = err == null ? "var(--color-text-tertiary)" : err >= 0.05 ? "var(--color-text-danger)" : err >= 0.01 ? "var(--color-text-warning)" : "var(--color-text-success)";
  return (
    <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
      <span>{fmtRps(rps)} rps</span>
      <span>p50 {fmtMs(p50)}</span>
      <span>p99 {fmtMs(p99)}</span>
      <span style={{ color: errColor }}>err {fmtErr(err)}</span>
    </div>
  );
}
```
Labels are always present (even when the value is `—`), per the spec.

(d) The caption — near the existing global-services caption (~line 161), add a
route-metrics status line:
```tsx
{rmStatus && (
  <div style={{ marginTop: 6, fontSize: 10, color: rmStatus.available ? "var(--color-text-tertiary)" : "var(--color-text-warning)" }}>
    {rmStatus.available
      ? rmStatus.message
        ? `route metrics · ${rmStatus.message}`
        : `route metrics · updated ${ago(rmStatus.updatedAt)}${rmStale ? " · stale" : ""}`
      : `route metrics unavailable: ${rmStatus.message}`}
  </div>
)}
```
with an `ago` helper (epoch/RFC3339 → "Ns ago"):
```tsx
function ago(iso: string): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
}
```

(e) RouteDetail "traffic" section: in the expanded `RouteDetail` (~line 202+),
add a small "traffic" block showing the same four values for the selected route
(`routeMetrics[selectedKey]`), with a one-line note: `p50/p99 are worst-rule
values`. Reuse `fmtRps`/`fmtMs`/`fmtErr`.

- [ ] **Step 5: Run vitest**

Run: `cd cmd/klyx/frontend && npx vitest run`
Expected: PASS (new NetworkTopology cases + all existing). If a `getByText`
collides (e.g. "rps" substring), tighten the matcher to the full lane text.

- [ ] **Step 6: Bindings + typecheck + full gate**

```bash
cd cmd/klyx && wails3 generate bindings && cd frontend && npx tsc --noEmit
```
Expected: bindings include `GatewayService.GetRouteMetrics`; `tsc --noEmit` clean.

From the repo root:
```bash
make test && go test -race ./internal/... && make vet
```
Then:
```bash
cd cmd/klyx && wails3 build
```
Expected: all PASS; `wails3 build` exit 0. (Ignore the pre-existing
`cmd/klyx/build/ios` main-undeclared artifact.)

- [ ] **Step 7: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/bridge/gateway.ts cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): live route rps/p50/p99/err on the network topology"
```

---

## Native verification (homelab) — after Task 7

0. **Metric-name gate first.** On the homelab Prometheus run:
   `count by (__name__)({__name__=~"envoy_cluster_upstream_rq.*"})` and
   `count by (envoy_cluster_name)(envoy_cluster_upstream_rq_total)`. Confirm the
   constants in `internal/routemetrics/envoy.go` (`mRqTotal`, `mRqTime`, `mRqXX`,
   `lRespClass`). If they differ, fix that one `const` block and re-run the gate.
1. Select an Envoy gateway with a route taking traffic → real `rps · p50 · p99 ·
   err`; numbers refresh on the ~20s poll; caption shows `updated Ns ago`.
2. Idle route → `0 rps · p50 — · p99 — · err —`, no alarm.
3. Cluster without Envoy Gateway → caption `route metrics unavailable: Envoy
   Gateway not detected`; no fake zeros.
4. Break the Envoy scrape (or a cluster genuinely lacks it) → caption `no
   envoy_cluster_* series found`; restore → numbers return.
5. Kill Prometheus briefly mid-view → numbers stay (last good) + `· stale`, not a
   flicker to `—`.

---

## Self-review notes (author)

- **Spec coverage:** InstantVector (T1); model+strict parser (T2); anchored escaped
  selector (T3); EnvoyClusterSource 5 queries + rule reducer (rps sum / p50-p99 max
  / err summed-then-divided) + existence-probe status (T4); fleet gating + transport
  reuse + UpdatedAt stamp (T5); appbridge DTOs + GetRouteMetrics (T6); store
  preserve-last-good + poller + lane line + caption + RouteDetail + full gate (T7).
  Two-level status, nil≠0, idle≠broken, labels-when-nil, worst-rule note, native
  metric-name gate all covered.
- **Type consistency:** `routemetrics.RouteMetrics`/`Status` cross routemetrics→fleet
  →appbridge unchanged; DTO json tags (`rps/p50/p99/errRate/available/message/
  updatedAt`) match the store TS types; `RouteMetrics(ctx, routeKeys)` identical in
  fleet impl, `Conn`, and `appbridge.GatewayConn`.
- **Known ripple:** T5 adds `RouteMetrics` to `Conn` (fakeConn stub) and T6 to
  `GatewayConn` (appbridge fake stubs) — both swept in-task.
- **Deferred (no task, by design):** Cilium/Hubble Source impl; routeKeys chunking;
  range/sparklines; multi-cluster aggregation.
