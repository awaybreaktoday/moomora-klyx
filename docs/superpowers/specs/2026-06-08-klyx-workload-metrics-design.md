# M7-c-ii-b: Workload CPU/Memory metrics — design

## Goal

Add per-workload CPU and memory to the Workloads health view as an **additive risk
lens**: live usage against the configured limit, surfacing OOM and throttling
proximity. Metrics enrich the view; they never mutate the Kubernetes-derived health
rank or the default triage sort.

## Context

This is the deferred second gate of M7-c-ii. M7-c-ii-a shipped the Workloads health
view (k8s-only: rank, ready/desired, restarts, failure reason, GitOps owner, inline
pod expand) with no Prometheus dependency. M7-c-ii-b layers metrics on top.

The split is deliberate and must stay visible: **Kubernetes health exists without
Prometheus.** A cluster with no metrics source shows exactly the M7-c-ii-a view. A
cluster with a live source additionally shows cpu/mem columns, saturation colour,
and a metrics-gated "near limit" sort.

Ownership of truth:

- **Kubernetes API** owns desired config: requests, limits, and the *no-limit* fact.
- **Prometheus** owns live usage only.

This is the core honesty stance: desired config comes from the pod spec Git
authored, not from a metrics scrape that can be absent, lagging, or label-mismatched.

## Non-goals

- **No rank mutation.** Saturation never changes the rank dot or the default sort.
  CrashLoopBackOff is broken; 95% memory is standing on the trapdoor. Different
  signals, different colours, never merged.
- **No kube-state-metrics dependency.** Requests/limits come from the pod spec.
- **No per-pod usage breakdown** in this slice (which replica is the hog) — a clean
  later enrichment. First job: "is this workload near a configured limit?"
- **No desired-replica footprint.** Saturation uses *currently matched live pods*,
  not desired replicas. Desired-capacity analysis is a separate lens.
- **No range/historical queries.** Instant usage only (cpu via rate over a short
  window; memory as the current working-set gauge).
- **No fabricated denominators or zeros.** Missing usage → `—`. Missing limit →
  `no limit`. Missing request → `—`. Never a fake number.

## Data sources

**Usage — Prometheus (the only Prometheus dependency).** Two instant queries per
namespace scope, via the existing `metrics.Client.InstantVector` (which already
drops NaN/Inf):

- cpu cores:
  `sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{namespace="<ns>",container!="",container!="POD"}[5m]))`
- memory bytes:
  `sum by (namespace,pod) (container_memory_working_set_bytes{namespace="<ns>",container!="",container!="POD"})`

(`container_cpu_usage_seconds_total` and `container_memory_working_set_bytes` are
cAdvisor series confirmed present on the homelab Prometheus. The `[5m]` rate window
is the v1 default; revisit only if it proves too smooth.)

When namespace is "all", the `namespace=...` matcher is dropped (cluster-wide query),
matching how `ListWorkloads("")` behaves.

**Requests / limits — pod spec.** Read directly from the *matched* pods'
`container.resources.requests/limits` — the pods already fetched by `ListWorkloads`.
This is authoritative, already in hand, and makes *no-limit* detection unambiguous:
the spec explicitly says whether a limit is set, whereas kube-state simply omits a
series (indistinguishable from a scrape gap).

## Model

Pure, pod-spec-derived (Prometheus-free) in `internal/workloads`:

```go
// A single resource (cpu or memory) for a workload.
type ResourceCell struct {
    Usage   *float64 // live, from Prometheus; nil when unavailable
    Request *float64 // sum iff EVERY matched container sets one, else nil → "—"
    Limit   *float64 // sum iff EVERY matched container sets one, else nil → "no limit"
}

type WorkloadResources struct {
    CPU ResourceCell // Usage/Request/Limit in cores
    Mem ResourceCell // Usage/Request/Limit in bytes
}

// Workload (M7-c-ii-a) gains:
//   Resources WorkloadResources
```

`nil` encodes the truth; no extra booleans:

- `nil Limit` has exactly one cause — not every matched container is capped for that
  resource — so it renders `no limit`.
- `nil Request` → `—`.
- `nil Usage` → `—` (Prometheus absent/unavailable; req/limit still render).

### Aggregation rules (the honesty contract)

Computed over the **currently matched live pods** (same join as `Assemble`), regular
containers only (init containers excluded as transient):

- **Limit** (per resource, independently for cpu and mem): if *every* matched
  container sets a limit → `Limit = sum`. If *any* container lacks one → `Limit =
  nil` → `no limit`. Summing only the limits that exist would invent a denominator
  smaller than reality and over-state saturation — a lie in the dangerous direction.
- **Request** (per resource): if *every* matched container sets a request → `Request
  = sum`, else `nil` → `—`. (First cut: no "partial" wording; partial → `—`. Never
  silently sum a partial request.)
- **Usage**: sum of matched pods' per-pod usage from Prometheus; `nil` if no source
  or no sample.
- Empty/nil selector matches **zero** pods (inherited from `Assemble`), so its cells
  are all `nil`.

## Saturation & colour

Saturation is computed only when both `Usage` and `Limit` are non-nil:
`saturation = Usage / Limit` (0–1+). Rendered as a bar + percentage with risk
colour. CPU and memory are **not symmetric**:

| resource | ≥ amber | ≥ red | wording |
|----------|---------|-------|---------|
| memory   | 75%     | 90%   | **OOM risk** |
| cpu      | 90%     | 100%  | **throttling risk** |

- Below amber → neutral/quiet bar fill.
- CPU red is *throttling risk*, never "failure risk" — throttling hurts but is not an
  OOM. Memory red is *OOM risk*. The wording stays distinct.
- `no limit` → value + muted `· no limit`, no bar, no percentage.
- `Usage` nil → `— / <limit>`, no colour (can't compute saturation without usage).

## Rank & sort

**The rank dot and the default sort are unchanged from M7-c-ii-a and strictly
Kubernetes-derived.** Default sort: `unhealthy → degraded → restarts → healthy →
namespace/name`. Metrics do not participate.

**Metrics-gated "near limit" sort** (a toggle, not a filter — keeps all rows visible
so cluster context isn't lost). Rendered only when live metrics are available. When
on, re-orders by:

1. memory saturation descending
2. cpu saturation descending
3. k8s rank
4. namespace/name

Memory risk is more failure-proximal than cpu, so it leads. **A workload with no
calculable saturation — either `no limit`, or usage unavailable — has no percentage
and therefore sorts *below* any workload with a calculable saturation.** It can show
high raw usage but cannot be "near limit."

## Layering & data flow

Mirrors the M7-b RouteMetrics split: structural data from the list call, live numbers
from a separate pollable call. Metrics never become a second source of workload truth.

1. **`internal/workloads/resources.go` (pure, extends M7-c-ii-a).** Aggregates
   request/limit from matched pods' container specs into `WorkloadResources`
   (`Usage` left nil). Reuses the *same* pod-to-workload join helper as `Assemble`
   (same namespace, same selector match, empty selector → zero pods) — not a copy.
   `ListWorkloads` now returns req/limit, so the expand's req/limit picture works
   even with Prometheus down.

2. **`internal/fleet` — `WorkloadMetrics(ctx, namespace)` (mirrors `RouteMetrics`).**
   Self-contained: re-lists workloads + pods, runs the same join, queries Prometheus
   for cpu/mem usage per pod, aggregates per workload, returns
   `map[workloadKey]{cpuUsage, memUsage *float64}` + a `Status` (available / message /
   updatedAt). Guarded by `ensureMetricsLocked` / `cap.Available`. Usage only.
   Re-list cost is accepted (namespace-scoped, on-demand, 30s cadence, typed lists are
   cheap). Workload key format is the stable `<kind>/<namespace>/<name>` used by the
   health list and the UI.

3. **`internal/appbridge`.** `WorkloadDTO.Resources` carries req/limit from the list
   (usage null). A new `GetWorkloadMetrics(cluster, namespace) WorkloadMetricsResultDTO`
   returns the usage map keyed by workload key + a status DTO. All numeric fields are
   `*float64` (nil = JSON null).

4. **Frontend.** Capability-gated cpu/mem columns and "near limit" control (rendered
   only when metrics available). A `getWorkloadMetrics` poller with the standard
   stale-guard. **Patch-merge**: a metrics poll updates only `resources.cpu.usage`,
   `resources.mem.usage`, and metrics status/updatedAt/stale — it never replaces
   structural workload rows. Saturation % and colour computed at render by a pure
   `saturation(usage, limit)` helper.

### Lifecycle

```
On WorkloadsView load:   ListWorkloads, then GetWorkloadMetrics
Every ~30s while open:   GetWorkloadMetrics only
On Refresh:              ListWorkloads + GetWorkloadMetrics
On namespace change:     ListWorkloads(ns) + GetWorkloadMetrics(ns)
On unmount:              stop polling
```

### Stale behaviour (same as route metrics)

- Successful poll → update usage + updatedAt, `stale = false`.
- Failed poll after a prior success → keep last usage, `stale = true`, show reason.
- Failed first poll → usage `—`, show "metrics unavailable" reason.
- Never blank values on a transient Prometheus hiccup. Flicker is a tiny liar.

## DTO shapes

Go (`internal/appbridge`):

```go
type ResourceCellDTO struct {
    Usage   *float64 `json:"usage"`
    Request *float64 `json:"request"`
    Limit   *float64 `json:"limit"`
}
type WorkloadResourcesDTO struct {
    CPU ResourceCellDTO `json:"cpu"`
    Mem ResourceCellDTO `json:"mem"`
}
// WorkloadDTO gains: Resources WorkloadResourcesDTO `json:"resources"`

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
    Usage  map[string]WorkloadUsageDTO `json:"usage"` // keyed by <kind>/<ns>/<name>
}
```

TypeScript mirrors these. The list DTO always includes a `resources` object so the
frontend can distinguish `no limit` (limit null) from "not loaded yet."

## Testing

**Pure `internal/workloads/resources.go`** (the honesty contract — weight here):

- every container has a memory limit → workload mem limit = sum; saturation computable.
- any container missing a memory limit → mem limit nil → `no limit` (the dangerous
  direction).
- any container missing a cpu limit → cpu limit nil → `no limit`.
- any container missing a request → request nil → `—` (no partial sum).
- multi-container pod sums correctly; init containers excluded.
- empty/nil selector → zero pods → all cells nil.

**Fleet `WorkloadMetrics`** (fake metrics client):

- PromQL construction (namespace scoping; cluster-wide when ns == "").
- per-pod → per-workload aggregation keyed by `<kind>/<ns>/<name>`, using the same
  join as `Assemble`.
- cap-gated: returns an unavailable status (not an error) when no source.
- honesty: nil usage when absent; no NaN/Inf leakage.

**Frontend**:

- pure `saturation(usage, limit)` → `{pct, tier}`: no-limit → no pct/colour;
  usage-absent → no tier; threshold boundaries (mem 75/90, cpu 90/100).
- merge patches usage only — a metrics poll never replaces structural rows.
- stale-on-transient-fail keeps last-good usage.
- near-limit sort order (mem-sat desc → cpu-sat desc → k8s rank → ns/name);
  no-limit rows sort below calculable ones.
- **metrics unavailable → cpu/mem columns and the near-limit control are not
  rendered** (pins the capability-gated UI boundary).

## Native verification (homelab)

In `klyx-test`:

- A Deployment with a small memory limit + a steady allocator pushing ~80–90% of it →
  confirm the mem bar goes red, the expand says **OOM risk**, the "near limit" sort
  floats it to the top, and **the rank dot stays grey** (k8s says it's fine right
  now). This makes the whole conceptual decision visible.
- A Deployment with no limits → `no limit`, no fake percentage, sorts below saturable
  workloads under "near limit".
- Briefly interrupt the metrics source → usage `—`, limit still shown from the pod
  spec, stale reason surfaced; on recovery, values return without a full row replace.
- Clean up: `kubectl delete ns klyx-test`.

## Design decisions (locked)

1. Anchor row usage to **limit** (saturation/risk lens), not request. Request lives in
   the expand (right-sizing).
2. Requests/limits from the **pod spec**, not kube-state — authoritative, already
   fetched, and the only way to detect *no limit* unambiguously.
3. **Any-container-uncapped → workload limit nil → `no limit`.** Never sum partial
   limits into a denominator.
4. Requests: sum iff every container has one, else `—`. Never sum partial requests.
5. Use **currently matched live pods** for both usage join and req/limit aggregation,
   not desired replicas.
6. Saturation is an **additive signal only** — it never mutates the k8s rank dot or
   the default triage sort.
7. CPU/memory asymmetry: memory limit is a hard ceiling (mem ≥75% amber, ≥90% red,
   **OOM risk**); cpu limit is throttling proximity (cpu ≥90% amber, ≥100% red,
   **throttling risk**). Wording stays distinct.
8. `WorkloadMetrics` is **self-contained** (re-derives pod→workload server-side);
   no pod-map token crosses the bridge. Keyed by `<kind>/<namespace>/<name>`.
9. **Light lifecycle**: fetch after list load, poll ~30s while open, refresh re-runs
   both; patch-merge usage only; last-good-on-transient-fail stale behaviour.
10. **Capability-gated UI**: metrics unavailable → cpu/mem columns and the near-limit
    control are hidden entirely; the view is the pure M7-c-ii-a health view.
11. **Rows with no calculable saturation (no limit, or usage unavailable) do not
    participate in saturation-percentage sorting** — they have no percentage, so they
    sort below any workload with a calculable saturation.
12. Reuse the **same pod-to-workload join semantics as `Assemble`** in the metrics
    path (shared helper, not a copy) — no second interpretation.
13. Metrics never blank on a transient hiccup; no fabricated zeros or denominators.
