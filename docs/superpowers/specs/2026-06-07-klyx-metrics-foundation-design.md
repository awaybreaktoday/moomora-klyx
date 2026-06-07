# Klyx M7-a: Prometheus metrics foundation — design

> Milestone M7 (inline observability) decomposes into a foundation slice plus
> three rendering slices. This spec covers **M7-a**, the foundation. M7-b
> (route p50/p99/rps), M7-c (workload CPU/mem), and M7-d (Flux reconcile
> duration) each get their own spec/plan/verify cycle on top of this.

## Goal

Land the Prometheus query data path end-to-end and prove it with one
proof-of-life metric surface: cluster CPU + memory utilization on the cluster
Overview, pulled on demand, sourced via PromQL. Honest about how it connected
and honest when it can't.

This realizes design principle #5 ("inline observability, not a separate
Grafana tab — Klyx queries, doesn't reinvent") for the first time, and is the
shared substrate every later metric surface builds on.

## Scope

In scope:
- A `internal/metrics` package: PromQL instant-query client, response parsing,
  two transports (direct HTTPS, API-server service proxy), 4-tier endpoint
  resolution, liveness-probed capability.
- Config: thread the existing per-cluster `MetricsConfig` (never wired until
  now), extend it with an explicit in-cluster `ServiceRef`.
- Conn layer: a lazy `ClusterMetrics` method, resolve+probe on first call,
  short-TTL sample cache.
- Appbridge `MetricsService` + DTO, store slice, Overview rendering of
  cpu/mem + a monitoring status line.

Out of scope (deferred to later M7 slices or future work):
- Route metrics, workload-card metrics, Flux reconcile duration (M7-b/c/d).
- Fleet-card metrics / background polling (M7-a is on-demand only).
- Range queries / sparklines (instant queries only for the foundation).
- Azure Monitor Managed Prometheus AAD/exec-token auth (static bearer +
  `tlsSkipVerify` only for now; AAD slots in later as another transport
  credential source without reshaping the resolver).

## Non-negotiable honesty model

Metrics are the category where querying the wrong backend can look valid while
being wrong — that is worse than failure. So:

1. **Never guess silently.** Explicit config wins. Heuristic discovery is
   labeled best-effort and surfaced. Multiple discovery matches → *unavailable
   with a warning to set `serviceRef`*, not a coin flip.
2. **Available means verified.** `MetricsCapability.Available` is true only
   after a live `vector(1)` query returns HTTP 200 with a valid Prometheus
   response body through the chosen transport. A resolved-but-unreachable
   backend reports `unavailable` with the real error (auth failed, proxy 503,
   DNS, non-Prometheus body).
3. **Nil is not zero.** A query that returns no data renders as "—", never a
   fabricated `0`. Metric fractions are `*float64`; nil ≠ 0.0.
4. **Surface the mode.** The UI always says how it connected: "monitoring:
   discovered · svc monitoring/prometheus-operated" or "monitoring
   unavailable: <real reason>".

`Warning` and `Reason` stay strictly distinct and must not blur:
- `Warning` = non-fatal context on an otherwise-working connection (e.g.
  `serviceRef ignored because endpoint is set`).
- `Reason` = why the connection is unavailable (e.g. `multiple candidate
  Services found, set metrics.serviceRef`).

UI examples:
```
available + warning:
  monitoring: endpoint https://prom.example ⚠ serviceRef ignored because endpoint is set
unavailable + reason:
  monitoring unavailable: multiple candidate Services found, set metrics.serviceRef
```

### Single-backend assumption (multi-cluster scoping deferred)

M7-a assumes the Prometheus backend selected for a cluster represents **that
cluster only**. The proof-of-life queries are unscoped aggregates; if the
backend is shared / federated / multi-cluster, they would aggregate across
everything. This is fine for the homelab (one Prometheus per cluster) and is an
explicit M7-a limitation. Multi-cluster label scoping is deferred: a later slice
adds optional `clusterLabel` / `clusterValue` to `MetricsConfig` and injects a
`{<label>="<value>"}` matcher into every query. Not built in M7-a.

## Architecture

```
config.MetricsConfig (per cluster)        ← now threaded through factory
        │
        ▼
internal/metrics
  resolve.go     4-tier Resolution{Mode,Source,Transport,Warning}
  transport.go   direct (HTTPS) | proxy (API-server service proxy)
  metrics.go     Client.InstantQuery, response parse, vector(1) liveness
  capability.go  MetricsCapability{Available,Mode,Source,Warning}
        │
        ▼
fleet.ClusterConn.ClusterMetrics(ctx)     ← lazy: resolve+probe on first call,
        │                                    cache capability + 15s sample TTL
        ▼
appbridge.MetricsService.GetClusterMetrics(name) → MetricsDTO  (on demand)
        │
        ▼
store metrics slice → cluster Overview (cpu/mem + monitoring status line)
```

### Package `internal/metrics`

`metrics.go`:

```go
// Sample is one scalar from an instant query (the single value of a
// one-element vector, or a scalar result). Absent reports "no data".
type Sample struct {
    Value  float64
    Absent bool
}

// Querier executes a PromQL instant query and returns the raw HTTP status
// and body. Transports implement this; the Client parses.
type Querier interface {
    InstantQuery(ctx context.Context, promql string) (status int, body []byte, err error)
}

type Client struct{ q Querier }

func NewClient(q Querier) *Client

// InstantScalar runs query, expects success + a vector/scalar, and returns the
// single value. A success response with an empty vector → Sample{Absent:true}.
// A multi-element vector → error (caller's query was not an aggregate).
func (c *Client) InstantScalar(ctx context.Context, promql string) (Sample, error)

// Liveness runs `vector(1)` and returns nil only on HTTP 200 + a valid
// Prometheus success body whose single value parses to float64 1.0. Non-200,
// status:"error", or an unparseable/non-Prometheus body → a descriptive error.
// Prometheus encodes sample values as JSON strings inside [ts, "1"]; compare
// the PARSED float (1.0), never the raw string.
func (c *Client) Liveness(ctx context.Context) error
```

Parsing targets the standard Prometheus HTTP API envelope
`{"status":"success"|"error","data":{"resultType":...,"result":[...]},"error":...}`.
A body that does not parse as this envelope → "not a Prometheus API" error
(this is how we reject pointing at a Grafana UI or a 200-returning ingress that
isn't Prometheus).

`transport.go`:

```go
// directTransport hits an external Prometheus/Mimir query URL over HTTPS.
// Adds `Authorization: Bearer <token>` when token != "". Honors tlsSkipVerify.
type directTransport struct {
    base   string // the Prometheus BASE URL, e.g. https://host/prometheus
    token  string
    client *http.Client
}

// proxyTransport queries through the kube API-server service proxy using the
// cluster's existing REST credentials. Path:
//   /api/v1/namespaces/{ns}/services/{scheme}:{name}:{port}/proxy/api/v1/query
type proxyTransport struct {
    rest   rest.Interface // from the conn's typed client CoreV1 RESTClient
    ns, name, port, scheme string
}

func (t directTransport) InstantQuery(ctx, promql) (int, []byte, error)
func (t proxyTransport) InstantQuery(ctx, promql) (int, []byte, error)
```

Both append `/api/v1/query?query=<promql>` (URL-encoded). Instant query only;
no `time` param (server uses "now").

**Endpoint URL format (strict).** `endpoint` MUST be the Prometheus base URL
**without** a trailing `/api/v1` (e.g. `https://host/prometheus`, not
`https://host/prometheus/api/v1`). The transport appends `/api/v1/query`
exactly once. Config validation rejects an `endpoint` ending in `/api/v1`
(or `/api/v1/`) with a clear message, so a misconfigured
`/api/v1/api/v1/query` can never happen. A single trailing `/` is trimmed.

`resolve.go`:

```go
type Mode string
const (
    ModeExplicitEndpoint Mode = "explicit-endpoint"
    ModeExplicitService  Mode = "explicit-service-ref"
    ModeDiscovered       Mode = "discovered-service"
    ModeUnavailable      Mode = "unavailable"
)

type Resolution struct {
    Mode      Mode
    Source    string  // URL, or "ns/name:port" for service modes
    Transport Querier // nil when Mode == unavailable
    Warning   string  // non-fatal note (e.g. endpoint+serviceRef both set)
}

// Resolve applies the 4-tier priority. `disco` is the SINGLE discovery outcome
// the fleet layer already reduced (see discovery rules below): at most one
// chosen candidate, or a multi-match signal.
//   1. endpoint set      → ModeExplicitEndpoint (direct transport)
//   2. serviceRef set    → ModeExplicitService  (proxy transport)
//   3. disco chose one   → ModeDiscovered        (proxy transport)
//   4. disco found none  → ModeUnavailable "no Prometheus Service found…"
//      disco multi-match  → ModeUnavailable "multiple candidate Services found,
//                           set metrics.serviceRef" (+ Reason)
func Resolve(cfg config.MetricsConfig, disco DiscoveryResult, mk TransportFactory) Resolution
```

**Discovery (fleet-layer; produces a single `DiscoveryResult`).** Discovery is
a two-stage process, and the multiple-match rule applies **within a stage**, not
across the whole ranked list — otherwise a cluster running both Prometheus and
Mimir would be "too honest to work."

Stage 1 — **ranked named-Service probe.** Check the ordered candidates in turn
and use the **first existing Service**. Ranking is the tiebreak by design; a
cluster with both `prometheus-operated` and `mimir-query-frontend` resolves to
`prometheus-operated` (first listed), never "multiple matches":

```
monitoring/prometheus-operated:9090
monitoring/kube-prometheus-stack-prometheus:9090
monitoring/prometheus-server:80
monitoring/mimir-query-frontend:8080
monitoring/mimir-nginx:80
```

Stage 2 — **label fallback, only if NO named candidate exists.** Query
`app.kubernetes.io/name=prometheus,component=server`, then
`app.kubernetes.io/name=mimir,component=query-frontend`. Use a hit only if it
yields exactly one Service with an unambiguous single port. If a label query
returns multiple Services → `DiscoveryResult` multi-match (unavailable, set
serviceRef). This is the only path that produces multi-match.

`DiscoveryResult` is `{Chosen *ServiceCandidate; MultiMatch bool}` where
`ServiceCandidate` is `{Namespace,Name,Port,Scheme}`. The fleet layer (live
client) computes it and hands it to `Resolve`.

`capability.go`:

```go
type MetricsCapability struct {
    Available bool
    Mode      Mode
    Source    string
    Warning   string
    Reason    string // populated when !Available (the real failure)
}

// Probe resolves then liveness-checks. Available only on a passing vector(1).
func Probe(ctx, res Resolution) MetricsCapability
```

### Config (`internal/config`)

```go
type MetricsConfig struct {
    Endpoint      string             `yaml:"endpoint"`
    Token         string             `yaml:"token"`
    TLSSkipVerify bool               `yaml:"tlsSkipVerify"`
    ServiceRef    *MetricsServiceRef `yaml:"serviceRef"`
}

type MetricsServiceRef struct {
    Namespace string `yaml:"namespace"`
    Name      string `yaml:"name"`
    Port      string `yaml:"port"`
    Scheme    string `yaml:"scheme"` // http|https; default http
}
```

Validation (extends `Config.validate`):
- `serviceRef`, when present, requires `namespace`, `name`, and `port`;
  `scheme` defaults to `http` and must be `http`/`https` if set.
- `endpoint`, when present, must be the Prometheus base URL and must NOT end in
  `/api/v1` or `/api/v1/` (rejected with a clear message); a single trailing
  `/` is trimmed.
- `endpoint` and `serviceRef` both set is not an error — `endpoint` wins, and a
  startup `Warning()` notes the ignored `serviceRef`.

### Conn layer (`internal/fleet`)

`MetricsConfig` is finally threaded:
- `ConnFactory`/`DefaultConnFactory` pass `cc.Metrics` into `NewClusterConn`.
- `ClusterConn` stores the metrics config and gains:

```go
// ClusterMetrics returns the proof-of-life metrics and the connection
// capability. Lazy: on first call it discovers candidates (if needed),
// resolves, and probes. Caching is asymmetric (see below). `forceReprobe`
// discards any cached capability and re-resolves+re-probes. Concurrency-safe.
func (c *ClusterConn) ClusterMetrics(ctx context.Context, forceReprobe bool) (ClusterMetrics, metrics.MetricsCapability)

type ClusterMetrics struct {
    CPUFraction *float64 // 0..1; nil = no data / unavailable
    MemFraction *float64 // 0..1; nil = no data / unavailable
}
```

Added to the `Conn` interface so the registry/appbridge can call it.

**Asymmetric capability caching** (so a probe during a Prometheus restart does
not stick like tar):
- **Available** capability is cached for the conn lifetime (the backend is
  proven; re-resolving every call is wasted work).
- **Unavailable** capability is cached for a short TTL (~45s) and re-probed on
  the next call after it expires — a backend that was down at first load
  self-heals without an app restart.
- A manual UI refresh calls with `forceReprobe=true`, which re-probes
  regardless of cache state (the explicit "it's back, check now" escape hatch).
- Metric **sample values** (the CPU/mem queries) are cached with a short TTL
  (~15s) independent of the capability cache.

Proof-of-life queries (node-exporter observed host usage; kube-prometheus-stack
ships these). These are observed **CPU/memory used**, not Kubernetes
requested/allocatable saturation — the UI wording reflects that (see below):
- CPU used: `1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))`
- Mem used: `1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)`

Each query degrades independently: an `Absent` sample → nil fraction → "—".
A transport error on an individual query (after the capability already probed
Available) → nil fraction for that metric, capability stays Available.

The proxy transport is built from the conn's existing typed client
(`c.typed.CoreV1().RESTClient()`) — no new client wiring. Discovery uses the
same client to list Services in the candidate namespaces.

### Appbridge + store

`internal/appbridge/metrics_service.go`:

```go
// Follows the established appbridge lookup-seam pattern (cf. MeshService,
// GatewayService): a closure resolves a cluster name to its Conn rather than
// holding the registry directly. Keeps the service testable with a fake.
type MetricsService struct {
    lookup func(clusterName string) (fleet.Conn, bool)
}

func NewMetricsService(lookup func(string) (fleet.Conn, bool)) *MetricsService

func (s *MetricsService) GetClusterMetrics(clusterName string) MetricsDTO
```

```go
type MetricsDTO struct {
    Available   bool     `json:"available"`
    Mode        string   `json:"mode"`
    Source      string   `json:"source"`
    Warning     string   `json:"warning"`
    Reason      string   `json:"reason"`
    CPUFraction *float64 `json:"cpuFraction"` // null = "—"
    MemFraction *float64 `json:"memFraction"` // null = "—"
}
```

Registered in `cmd/klyx/main.go` like the other services. On-demand only — no
push loop.

Store: a `metrics` slice keyed by cluster name, populated by a
`bridge.getClusterMetrics(name, forceReprobe)` call fired when the Overview
mounts (`forceReprobe=false`) and on an explicit refresh affordance
(`forceReprobe=true`). Standard loading/error handling.

### UI — cluster Overview

The Overview (cluster drilldown) gains, alongside the existing nodes/pods line:
- A compact **cpu used / mem used** readout: percent + a thin usage bar, colour
  from CSS status vars. The labels are "cpu used" / "mem used" — these are
  observed host usage (node-exporter), NOT Kubernetes requested/allocatable
  saturation, and the wording must not imply capacity/request pressure. Null
  fraction → "—" (no bar).
- A **monitoring status line** that states the mode honestly:
  - available: `monitoring: discovered · svc monitoring/prometheus-operated`
    (or `· endpoint <host>` / `· svc <ns/name:port>` per mode)
  - warning present: append `⚠ <warning>`
  - unavailable: `monitoring unavailable: <reason>`
- A manual refresh affordance that triggers a `forceReprobe` re-probe.
- Loading and error states.

No fleet-card metrics in M7-a.

## Testing

- `internal/metrics`:
  - Response parsing table tests: success scalar, success single-vector,
    success empty vector (→ Absent), `status:"error"`, non-Prometheus body,
    multi-element vector (→ error).
  - `Liveness`: 200+valid → nil; 401/503 → error with status; non-prom body →
    "not a Prometheus API"; value encoded as `[ts,"1"]` string parses to 1.0.
  - `Resolve`: each of the 4 tiers; endpoint+serviceRef → endpoint wins +
    warning; `disco` chose-one → discovered; `disco` multi-match → unavailable
    + reason; `disco` none → unavailable.
  - Discovery reduction (the fleet-layer stage): **both** prometheus and mimir
    named Services present → picks `prometheus-operated` (first listed), NOT
    multi-match (the "too honest to work" regression guard); no named Service +
    one label hit → chosen; no named Service + multiple label hits →
    multi-match.
  - Transports use a fake `http.RoundTripper` / fake REST client; no live calls.
- `internal/config`: serviceRef validation (missing fields, bad scheme),
  endpoint+serviceRef precedence warning, and `endpoint` ending in `/api/v1`
  rejected.
- `internal/fleet` (or `internal/metrics`) caching: unavailable capability
  re-probes after its short TTL; available capability stays cached;
  `forceReprobe=true` re-probes regardless.
- `internal/appbridge`: `GetClusterMetrics` DTO mapping via a fake `Conn` —
  available with fractions, available with nil fractions, unavailable with
  reason.
- frontend vitest: Overview renders cpu/mem percents + bars, "—" for null,
  and each monitoring status-line variant (discovered / endpoint / warning /
  unavailable).

## Native verification (homelab)

1. `homelab-blue` Overview → real cpu/mem percentages + `monitoring:
   discovered · svc monitoring/<matched>`. (Confirms proxy transport +
   discovery + parse end-to-end.)
2. Pin a deliberately wrong `serviceRef` on one cluster in fleet config →
   Overview shows `monitoring unavailable: <real proxy error>`, no crash, no
   fake zeros.
3. A cluster with no Prometheus (or `nelli`) → `monitoring unavailable: no
   Prometheus Service found`, cpu/mem "—".
4. (If reachable) set an explicit `endpoint` for one cluster → mode shows
   `explicit-endpoint`, values render.
5. Restart-recovery: with the wrong-serviceRef cluster showing unavailable,
   correct the config (or the backend recovers) and hit the manual refresh →
   it re-probes and flips to available, without restarting the app.

## File structure

- Create: `internal/metrics/metrics.go`, `transport.go`, `resolve.go`,
  `capability.go` (+ `_test.go` peers).
- Modify: `internal/config/config.go` (+ `MetricsServiceRef`, validation),
  `internal/fleet/conn.go` (interface + `ClusterMetrics`, store config),
  `internal/fleet/factory.go` (thread `cc.Metrics`), a new
  `internal/fleet/metrics.go` (discovery + lazy resolve/probe/cache).
- Create: `internal/appbridge/metrics_service.go`, `metrics_dto.go`.
- Modify: `cmd/klyx/main.go` (register `MetricsService`),
  `cmd/klyx/frontend/src/store/fleet.ts` (metrics slice + DTO),
  the cluster Overview view (cpu/mem + monitoring line), bridge.

## Decisions log

1. Hybrid connection: `endpoint` (direct HTTPS) when set, else API-server
   service proxy. Managed Prometheus first-class; homelab zero-config.
2. 4-tier resolution: endpoint → serviceRef → ranked discovery → unavailable.
3. Discovery is ranked named-Service probe + guarded label fallback; multiple
   matches never guessed — unavailable with a "set serviceRef" warning.
4. `Available` is probe-confirmed via `vector(1)`; resolved ≠ available.
5. On-demand lifecycle on the cluster Overview (lazy like GitOps watch); short
   sample TTL; no fleet-card polling in M7-a.
6. Nil fractions (`*float64`) distinguish "no data" from `0`; UI renders "—".
7. Static bearer + tlsSkipVerify auth now; Azure Monitor AAD deferred.
8. Proof-of-life metrics are node-exporter observed cluster **CPU used** and
   **memory used** (host usage, not allocatable/requested). UI wording reflects
   "used", not capacity saturation.
9. Discovery multi-match is a within-stage rule: ranked named Services use
   first-listed (ranking IS the tiebreak); only label fallback can produce
   multi-match. Prevents "too honest to work" on prometheus+mimir clusters.
10. `endpoint` is strictly the base URL without `/api/v1` (validation-enforced);
    transports append `/api/v1/query` exactly once.
11. Asymmetric capability caching: available cached for conn lifetime,
    unavailable short-TTL + re-probe, manual refresh forces re-probe — so a
    probe during a Prometheus restart never sticks.
12. `Warning` (non-fatal context on a working connection) and `Reason` (why
    unavailable) stay strictly distinct.
13. Single-backend assumption: M7-a treats the selected Prometheus as
    representing only that cluster; multi-cluster `clusterLabel`/`clusterValue`
    scoping is deferred.
