# Klyx M7-b: Route latency/RPS metrics on the network topology — design

> Milestone M7 (inline observability) slice **M7-b**. Builds directly on the
> M7-a Prometheus foundation (`internal/metrics`, `(*ClusterConn).ClusterMetrics`,
> probe-confirmed `MetricsCapability`). Sibling slices M7-c (workload CPU/mem) and
> M7-d (Flux reconcile duration) come later.

## Goal

Render live per-route traffic signals — **rps, p50, p99, error rate** — on each
HTTPRoute lane of the Gateway API network topology, sourced from Envoy Gateway's
Prometheus metrics. The structural topology stays a snapshot on gateway-select;
the numbers poll on a short interval and patch in place. Honest about what's
measured, what's idle, and what isn't scraped.

This is design principle #5 ("p50/p99/rps next to the route") realized on the
graph we built in M5, using the query path proven in M7-a.

## Scope

In scope:
- A pure `internal/routemetrics` package: a `Source` seam, the `EnvoyClusterSource`
  implementation (PromQL construction + result reduction), and the `RouteMetrics`/
  `Status` value types.
- One `internal/metrics` extension: `Client.InstantVector` (returns labeled
  samples, not a single scalar).
- A fleet method `(*ClusterConn).RouteMetrics` that reuses the M7-a transport,
  gates on capability, and runs the source.
- An appbridge `GatewayService.GetRouteMetrics` + DTOs.
- A frontend polling lifecycle + route-lane rendering + a freshness/status caption.

Out of scope (deferred):
- Cilium/Hubble L7 metrics as a second `Source` (the seam exists; no impl in M7-b).
- Per-service or per-pod metrics (M7-c).
- Range queries / sparklines / historical charts.
- Multi-cluster route-metric aggregation.
- routeKeys chunking for very large gateways (M7-b uses one regex alternation pass).

## Hard gate: native metric-name verification precedes final constants

The exact Envoy metric names and label keys vary by Envoy/Gateway version and
stats config. **Do not finalize the PromQL constants until native verification
on the homelab confirms them.** The design (join, seam, queries, honesty) stands
regardless; only the literal metric/label strings are verification-dependent.

Verification queries to run against the homelab Prometheus first:
```
count by (__name__)({__name__=~"envoy_cluster_upstream_rq.*"})
count by (envoy_cluster_name)(envoy_cluster_upstream_rq_total)
```
Confirm: the request-total counter name, the request-time histogram bucket name,
the per-response-class counter name/label, and that `envoy_cluster_name` is the
join label carrying `httproute/<ns>/<name>/rule/<idx>`.

## The metric → route join

Envoy Gateway names each route-rule's upstream cluster:
```
envoy_cluster_name = httproute/<namespace>/<name>/rule/<idx>
```
A topology route node is identified by `(namespace, name)`. Its metrics are every
series whose `envoy_cluster_name` matches that route, **summed across rules**
(the topology node is the HTTPRoute, not a rule).

**Strict cluster-name parser** (skip, never guess):
```
accept:  httproute/<namespace>/<name>/rule/<number>   -> routeKey "<namespace>/<name>"
reject:  httproute/<namespace>/<name>                 (no rule segment)
reject:  httproute/<namespace>/<name>/rule/foo        (non-numeric rule)
reject:  anything not matching the exact shape
```
`<namespace>` and `<name>` are single path segments (no `/`); `<number>` is
`[0-9]+`. A cluster name that doesn't parse is dropped from the reduction.

## Queries — 5 grouped vectors per poll

Scoped to the requested route keys via an **anchored, regex-escaped** alternation
(route names/namespaces are K8s names but are still escaped for regex safety):
```
selector = envoy_cluster_name=~"^httproute/(esc(ns1)/esc(n1)|esc(ns2)/esc(n2)|...)/rule/[0-9]+$"
```
where `esc()` escapes PromQL/RE2 metacharacters. Each query returns a vector
keyed `by (envoy_cluster_name)` — i.e. **per rule** (the cluster name carries the
rule index). The reducer aggregates rules into routeKeys (see below). Crucially,
**the error rate is NOT divided in PromQL**: dividing per rule and then combining
would average fractions, which is wrong. Instead the 5xx and total request rates
are returned as separate vectors and divided per routeKey after summing across
rules. The five queries (exact metric names pending the hard gate above; these
are the expected forms):

```
rps    = sum by (envoy_cluster_name)(rate(envoy_cluster_upstream_rq_total{<selector>}[5m]))

p50    = histogram_quantile(0.50, sum by (envoy_cluster_name, le)(
           rate(envoy_cluster_upstream_rq_time_bucket{<selector>}[5m])))

p99    = histogram_quantile(0.99, sum by (envoy_cluster_name, le)(
           rate(envoy_cluster_upstream_rq_time_bucket{<selector>}[5m])))

rq5xx  = sum by (envoy_cluster_name)(rate(envoy_cluster_upstream_rq_xx{<selector>,envoy_response_code_class="5"}[5m]))

rqall  = sum by (envoy_cluster_name)(rate(envoy_cluster_upstream_rq_xx{<selector>}[5m]))
```

Five queries per poll regardless of route count. `histogram_quantile` yields NaN
at zero traffic; `rq5xx`/`rqall` are absent at zero traffic — both reduce to nil
(below). Latency is in **milliseconds** (Envoy `upstream_rq_time` is ms).

**Empty-routeKeys guard:** if `routeKeys` is empty, return an empty result
immediately without querying (never build an empty alternation).

## Architecture

```
frontend NetworkTopology (has the open topology's route keys)
   │  poll every ~20s while a gateway is selected
   ▼
appbridge GatewayService.GetRouteMetrics(cluster, routeKeys[])  → RouteMetricsResultDTO
   ▼
fleet (*ClusterConn).RouteMetrics(ctx, routeKeys) (map[routeKey]RouteMetrics, Status)
   │  gate on Network.HasEnvoyProxy; reuse the cached M7-a metrics transport
   ▼
routemetrics.EnvoyClusterSource.QueryRouteMetrics(ctx, routeKeys)
   │  build selector + 5 PromQL → metrics.Client.InstantVector → reduce by cluster name
   ▼
metrics.Client.InstantVector(ctx, promql) ([]LabeledSample, error)   (M7-a extension)
```

### `internal/metrics` extension

```go
// LabeledSample is one series from an instant vector query.
type LabeledSample struct {
	Labels map[string]string
	Value  float64
}

// InstantVector runs an instant query expecting a vector and returns every
// element with its labels. NaN/Inf values are skipped (not returned) — a
// non-finite sample is "not meaningful", consistent with InstantScalar's
// absent handling. An empty vector returns an empty slice, nil error.
func (c *Client) InstantVector(ctx context.Context, promql string) ([]LabeledSample, error)
```
NaN/Inf are filtered here so they never reach the reducer or the DTO. (Reuses the
M7-a envelope parser; only the result-shaping differs from `InstantScalar`.)

### `internal/routemetrics` (new pure package)

```go
// RouteMetrics is the per-route traffic readout. Nil = no usable value
// (no series, or non-meaningful e.g. latency/err at zero traffic).
// ErrRate is a FRACTION in [0,1], not a percent.
type RouteMetrics struct {
	RPS     *float64
	P50     *float64 // milliseconds
	P99     *float64 // milliseconds
	ErrRate *float64 // fraction 0..1
}

type Status struct {
	Available bool
	Reason    string
	UpdatedAt time.Time
}

// Source produces per-route metrics for a set of route keys ("<ns>/<name>").
// EnvoyClusterSource is the only implementation in M7-b; Hubble/Cilium can
// implement it later without touching the topology.
type Source interface {
	QueryRouteMetrics(ctx context.Context, routeKeys []string) (map[string]RouteMetrics, error)
}

// EnvoyClusterSource builds Envoy-cluster PromQL and reduces the result.
type EnvoyClusterSource struct{ client *metrics.Client }
func NewEnvoyClusterSource(c *metrics.Client) *EnvoyClusterSource
```

Pure, unit-testable with a fake `metrics.Querier`:
- `buildSelector(routeKeys) string` — escapes + anchors the alternation.
- `parseClusterName(name) (routeKey string, ok bool)` — the strict parser.
- the reducer.

**Reduction (rules → route), deterministic and documented.** Every query returns
per-rule vector elements (one per `envoy_cluster_name`). The reducer parses each
cluster name to its routeKey and aggregates the rules of a route:
- **rps** = sum of the `rps` vector elements across the route's rules.
- **p50 / p99** = **max** across the route's rules (worst-rule tail latency is the
  honest route-level signal; averaging quantiles is not meaningful).
- **errRate** = `sum(rq5xx across rules) / sum(rqall across rules)` — summed
  first, divided once, per routeKey. Never average per-rule fractions. If
  `sum(rqall) == 0` (or no `rqall` elements) → `errRate` nil.
- **measured = presence in the rps vector.** A routeKey with at least one `rps`
  element gets a map entry (rps is a real value, possibly 0). A routeKey with no
  matching series gets **no** map entry → renders all `—`. For a present route,
  any individual field with no usable value (e.g. p99 NaN-filtered out at zero
  traffic) is nil for that field only.

### Three "no data" states (sharp definitions)

| Condition | Status | Per-route render |
|-----------|--------|------------------|
| M7-a metrics unavailable | `Available:false`, reason `metrics unavailable: <M7-a reason>` | all `—` + caption |
| Envoy not detected (`!HasEnvoyProxy`) | `Available:false`, reason `Envoy Gateway not detected` | all `—` + caption |
| No `envoy_cluster_*` series exist at all | `Available:false`, reason `no envoy_cluster_* series found` (scrape/PodMonitor likely missing) | all `—` + caption |
| Series exist but none match these route keys | `Available:true`, reason `no route series matched this topology` (unmeasured / naming mismatch / no traffic yet) | all `—`, no alarm |
| Some routes match | `Available:true` | matched routes show numbers; unmatched render `—` |

The "no `envoy_cluster_*` series at all" probe is a cheap existence query
(`count(envoy_cluster_upstream_rq_total)` or the rps query with no selector
returning empty) run when the scoped query returns zero series, to distinguish
"scrape missing" from "these routes are just idle".

## Lifecycle

- **Fleet:** `(*ClusterConn).RouteMetrics(ctx, routeKeys)`:
  1. If `len(routeKeys)==0` → empty map, `Status{Available:true, UpdatedAt:now}`.
  2. If `!caps.Network.HasEnvoyProxy` → `Status{Available:false, Reason:"Envoy Gateway not detected"}`.
  3. Resolve/reuse the M7-a metrics transport (same lazy cache as `ClusterMetrics`).
     If metrics capability is unavailable → `Status{Available:false, Reason:"metrics unavailable: "+capReason}`.
  4. Build `EnvoyClusterSource` on a `metrics.Client` over that transport; run it.
  5. Distinguish the no-series cases per the table; set `UpdatedAt = clk.Now()` on success.
- **Appbridge:** `GatewayService.GetRouteMetrics(cluster string, routeKeys []string) RouteMetricsResultDTO`.
  On-demand only, no push loop. 30s ctx timeout.
- **Frontend:** a polling effect tied to the selected gateway: fire immediately on
  select, then every ~20s; stop on unmount / gateway change. Patches numbers in place.

### DTOs

```go
type RouteMetricDTO struct {
	RPS     *float64 `json:"rps"`
	P50     *float64 `json:"p50"`     // ms
	P99     *float64 `json:"p99"`     // ms
	ErrRate *float64 `json:"errRate"` // fraction 0..1
}
type RouteMetricsStatusDTO struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
	UpdatedAt string `json:"updatedAt"` // RFC3339; "" when never succeeded
}
type RouteMetricsResultDTO struct {
	Status RouteMetricsStatusDTO        `json:"status"`
	Routes map[string]RouteMetricDTO    `json:"routes"` // keyed "<ns>/<name>"
}
```
Nil `*float64` → JSON `null` → UI `—`. Never 0 for "no data".

### Frontend store + freshness/staleness

Network slice gains `routeMetrics: Record<routeKey, RouteMetricDTO>`,
`routeMetricsStatus: { available, reason, updatedAt } | null`, and a derived
`routeMetricsStale: boolean`.

**Transient-failure behavior (preserve last good):** on a poll whose result is
`available:false` *after* a prior successful poll, the store KEEPS the last good
`routeMetrics` and the last good `updatedAt`, sets `routeMetricsStale = true`,
and surfaces the reason. It does NOT blank the numbers to `—`. A fresh successful
poll clears stale and replaces values + updatedAt. This prevents flicker between
numbers and `—` during transient Prometheus hiccups.

## Rendering

- **Route lane box:** a compact monospace line under the route name:
  `12.4 rps · p50 8ms · p99 42ms · err 0.3%`. **Labels always present even when
  nil** (a naked `0 rps · — · — · —` is cryptic), so an idle route reads
  `0 rps · p50 — · p99 — · err —`. `err` colored by threshold (success / warning
  / danger from CSS status vars). `errRate` rendered as `Math.round(errRate*100)`
  with a sensible precision for small values.
- **RouteDetail panel:** a "traffic" section with the same four, slightly larger,
  plus the freshness line.
- **Topology caption:** when `status.available` is false → `route metrics
  unavailable: <reason>`; when available → a subtle `route metrics · updated
  <Ns> ago` (and `· stale` when `routeMetricsStale`). Freshness is always visible.

## Testing

- `internal/metrics`: `InstantVector` — labeled vector parse, multi-series,
  empty vector → empty slice, NaN/Inf filtered out, non-200/non-Prometheus error.
- `internal/routemetrics`:
  - `parseClusterName` accept/reject table (the strict cases above).
  - `buildSelector` — escaping + anchoring; empty routeKeys handled by caller.
  - reducer — multi-rule rps sum; per-route p50/p99 (max across rules); err =
    sum(rq5xx)/sum(rqall) per route (NOT averaged per-rule fractions); `rqall==0`
    → err nil; missing rps series → no entry; NaN already filtered.
  - `QueryRouteMetrics` against a fake `Querier` returning canned vectors for the
    5 queries, asserting the assembled `map[routeKey]RouteMetrics` incl. the idle
    (rps 0, latency/err nil) case and a multi-rule route (rps summed, err summed-
    then-divided, latency maxed).
- `internal/fleet`: `RouteMetrics` gating — empty keys, `!HasEnvoyProxy`,
  metrics-unavailable, no-series-at-all vs no-match, success.
- `internal/appbridge`: `GetRouteMetrics` DTO mapping (nil→null, status fields,
  UpdatedAt formatting).
- frontend: poller start-on-select / stop-on-change; merge + render numbers and
  `—`; preserve-last-good on transient failure (stale flag, numbers retained);
  status caption variants; freshness "updated Ns ago".

## Native verification (homelab)

0. **Gate:** run the two `count by(...)` queries on homelab Prometheus; confirm
   exact metric/label names; adjust the query constants if they differ.
1. Select an Envoy gateway with a route taking traffic → real `rps · p50 · p99 ·
   err`; numbers refresh on the ~20s poll.
2. An idle route (no traffic) → `0 rps · p50 — · p99 — · err —`, no alarm.
3. A cluster without Envoy Gateway → caption `route metrics unavailable: Envoy
   Gateway not detected`; no fake zeros.
4. If reachable: temporarily break the Envoy PodMonitor / scrape so the series
   vanish → caption `no envoy_cluster_* series found`; restore → numbers return.
5. Kill Prometheus briefly mid-view → numbers stay (last good) with a `stale`
   indicator, not a flicker to `—`.

## File structure

- Create: `internal/metrics/vector.go` (+ `vector_test.go`) — `InstantVector` +
  `LabeledSample`. (Or extend `parse.go`; keep vector shaping in its own file.)
- Create: `internal/routemetrics/{model.go,source.go,envoy.go,*_test.go}` — types,
  `Source`, `EnvoyClusterSource` (selector/parser/reducer/queries).
- Modify: `internal/fleet/gateway.go` or new `internal/fleet/routemetrics.go` —
  `(*ClusterConn).RouteMetrics`; reuse the M7-a transport accessor from
  `internal/fleet/metrics.go` (may need a small internal helper to expose the
  resolved `metrics.Client` to the route-metrics path without re-probing).
- Modify: `internal/fleet/conn.go` — add `RouteMetrics` to the `Conn` interface.
- Modify: `internal/appbridge/gateway_service.go` + `gateway_dto.go` —
  `GetRouteMetrics` + the DTOs.
- Modify: `cmd/klyx/frontend/src/store/fleet.ts` (slice + types),
  `cmd/klyx/frontend/src/bridge/gateway.ts` (`getRouteMetrics`),
  `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx` (lane line + caption +
  poller), `NetworkView.tsx` if the poller lives there.

## Decisions log

1. Source: Envoy `envoy_cluster_*` joined by `envoy_cluster_name` =
   `httproute/<ns>/<name>/rule/<idx>`, summed across rules. Pluggable `Source`
   seam; `EnvoyClusterSource` the only M7-b impl (Cilium/Hubble deferred).
2. Metric set: rps + p50 + p99 + err-rate (fraction 0..1).
3. Five grouped vector queries per poll (rps, p50, p99, rq5xx, rqall), anchored +
   regex-escaped alternation scoped to the open topology's route keys; empty keys
   → no query. Error rate divided once per route after summing rules, never
   averaged from per-rule fractions.
4. Lifecycle: structural topology snapshot on select; route metrics poll ~20s,
   patch in place, stop on unmount/gateway change.
5. Two-level status: M7-a `MetricsCapability` (Prometheus reachable) is distinct
   from `routemetrics.Status` (Envoy route series usable), with sharply-defined
   no-data reasons.
6. Honesty: nil≠0; idle route = `0 rps` + `—` latency/err; NaN/Inf filtered in
   `InstantVector` so they never reach the DTO; strict cluster-name parser skips
   (never guesses); labels shown even when nil.
7. Freshness: `UpdatedAt` in the DTO, shown as "updated Ns ago"; transient poll
   failure preserves last-good values + marks stale, no flicker.
8. `InstantVector` is the only M7-a foundation extension; the resolved transport
   is reused, not re-probed.
9. Hard gate: native verification of exact Envoy metric/label names before the
   PromQL constants are finalized.
