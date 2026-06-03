# Klyx foundation design (M1 spine through M6 direction)

Date: 2026-06-03
Status: approved design, pre-implementation
Scope: one mega-spec covering the data-layer spine and the five foundational
decisions, designed through M6. M1 parts are build-ready; M3 (drift) and M6
(coexistence/resolve) parts are designed but rest on assumptions flagged in
"Assumptions to validate".

## 1. Context

Klyx is a fleet-first, read-mostly Kubernetes desktop client (Go + Wails v3,
client-go informers, React webview). This spec resolves the foundational design
decisions surfaced while reviewing the brief, principles, open questions, and
mockups, and lays down the data-layer architecture everything else plugs into.

The differentiator is the multi-cluster fleet and semantic rendering of CRDs
(GitOps drift, Gateway API graph), not single-cluster admin. The design is
therefore organised around a per-cluster connection spine that fans out cleanly
and isolates failures.

## 2. Fixed inputs (decisions taken)

1. **Fleet membership = Klyx-owned config file.** A Klyx config lists the
   fleet's clusters with their grouping and environment tags (prd/stg/dev/...).
   kubeconfig is used only to resolve credentials. Environment tags are
   declared here, never inferred from context names. This also resolves the
   "how does Klyx know a cluster is prd" footgun for guarded actions.
2. **Metrics transport = per-cluster ingress-exposed Prometheus-compatible
   endpoint + token**, declared in the same Klyx config. The metrics layer is
   one uniform PromQL/HTTP client; no per-provider auth branching.
3. **Drift diff = live-vs-applied.** Computed from server-side-apply managed
   fields / the last-applied annotation - no Git clone, no SOPS decryption, no
   client-side re-render. This is vocabulary-correct: it is exactly what Flux
   calls drift (live diverged from applied desired state). "View in git" is a
   separate source-resolution concern.
4. **Resolve on split-brain = diagnose-only.** Relabelled "inspect conflict".
   Klyx shows both reconcilers' claims and applied manifests and links to Git;
   it never edits ownership labels or deletes a claim. Fix belongs in Git
   (principle 9).
5. **M1 connects >=2 clusters as the architectural validation bar**, while the
   product fully supports a single-cluster fleet as a first-class config.

## 3. Architecture and package layout

```
cmd/klyx/main.go              # Wails v3 bootstrap, wires layers
internal/
  config/                     # Klyx-owned fleet config: clusters, tags, grouping, metrics endpoints
  cluster/                    # connection layer: kubeconfig cred resolution, exec-plugin auth, isolation
  fleet/                      # data layer spine
    registry.go               #   ClusterRegistry - owns N ClusterConn, lifecycle, fan-out
    conn.go                   #   ClusterConn - one informer factory, lazy watches, health/staleness FSM
    aggregate.go              #   cross-cluster queries (SearchPods, fleet summary)
  capability/                 # tiered capability detection per cluster
  metrics/                    # PromQL client, per-cluster endpoint, query templates
    templates/                #   built-in PromQL templates by resource kind, config-overridable
  gitops/
    flux/  argo/              # separate vocabulary-correct models (principle 8)
    drift/                    # live-vs-applied diff engine
    source/                   # live resource -> Flux sourceRef -> Git deep link
    coexistence.go            # split-brain detection
  viewmodel/                  # FleetVM, GitOpsVM, NetworkVM, CRDVM - the Wails-bound surface
frontend/src/                 # React: views/, components/, theme/, palette/
```

## 4. Data-layer spine

Answers open questions Q1 (informer model), Q2 (failure isolation), Q3
(cross-cluster aggregation), Q17 (staleness).

- **ClusterRegistry** is built from the Klyx config and holds one **ClusterConn**
  per configured cluster. Construction dials nothing - every conn starts
  `Unconnected`. Memory is paid only on actual connection (Q1).
- **ClusterConn** owns one client-go informer factory and runs in its own
  goroutine under its own context. State machine:
  `Unconnected -> Connecting -> Synced -> {Degraded, Stale, Failed}`. A failure
  or panic in one conn is caught and surfaced as that card's state; it never
  cascades (Q2). The registry hands the UI a per-cluster snapshot plus
  `lastSuccessfulSync`.
- **Lazy informers with an eager set.** On connect, a conn starts only the
  watches the fleet card needs. Deeper watches (namespaced pods, HTTPRoutes, CRD
  instances) start on first drilldown and stop after a TTL when no view needs
  them.
- **Eager set uses metadata-only informers** (`PartialObjectMetadata` via the
  metadata client). Counting ~500 pods x 6 clusters with full Pod objects is the
  source of the ~150MB estimate; metadata-only watches give live counts at a
  fraction of the cache cost. Eager set = nodes (ready/total), pods
  (metadata-only count), GitOps summary objects (Kustomization/HelmRelease or
  Application - few in number), capability-detection result. cpu/mem% come from
  the metrics layer, not informers.
- **Cross-cluster queries aggregate at the data layer** (Q3): `aggregate.go`
  fans out to every `Synced` conn, merges, and annotates partial failures
  ("M of N clusters answered"). The view layer never sees N connections.
- **Staleness (Q17):** `Synced` while watches are connected and resyncing;
  `Stale` (amber, "last refresh Nm ago") when a watch drops but cache is held;
  `Failed` when connection/auth fails. Amber threshold configurable, default 60s
  without a successful watch event.

## 5. Capability detection (tiered)

Spine of principle 7. Presence-only is insufficient (Q4/Q5), so state is tiered.

Core states per capability: `Absent` (CRDs/APIs not served - view hidden),
`Degraded` (installed but not fully working/partial - view renders with a named
banner), `Healthy` (installed and operational).

Two passes per cluster, on connect and on slow resync:

1. **Presence** (cheap): discovery API + CRD GVKs. Drives Absent vs present and
   pins the served API version (e.g. `gateway.networking.k8s.io/v1` vs only
   `v1beta1`). Version skew is resolved here once, not at each call site.
2. **Health** (present capabilities only): controller Deployment availability +
   capability CRD conditions. Reuses eager-set informers; no extra polling.

Capabilities are distinct types behind a common `Capability` interface (state +
human reason). Typed detail differs:

- `GitOpsCapability` -> `{flux:{present,version,controllers[],healthy},
  argo:{present,version,healthy}, coexistence bool}`. Models both tools because
  the GitOps view needs them together.
- `NetworkCapability` -> `{gatewayAPI:{version,hasEnvoyProxy},
  cilium:{present,hasHubble,clusterMesh}, ingressControllers[]}`. Gateway API
  present without EnvoyProxy is `Degraded`, not Absent (Q5).
- `ObservabilityCapability` -> `{metricsServer:present,
  promEndpoint:{configured,reachable}}`.

Contract to the view layer: a view renders, renders-with-banner, or is hidden,
and the empty/banner state always names what is missing - never a blank pane.

Decisions:
- **Non-Envoy ingress (Q10):** detect and name the controller; render the
  generic Ingress/Gateway-API view where CRDs are standard; invest in
  first-class topology rendering only for Envoy Gateway in milestone scope.
  Traefik/AWS LBC get "detected, generic view".
- **ClusterMesh (Q11):** `Healthy` only when clustermesh status shows actual
  connected peers. Never draw a mesh edge on inference.

## 6. Metrics layer

One uniform PromQL/HTTP `metrics.Client` per cluster, built from config
`{endpoint, token, tlsSkipVerify?}`, speaking the Prometheus HTTP query API. It
is a capability, not a hard dependency: no endpoint or unreachable -> reported
by `ObservabilityCapability`, UI shows a named empty state.

- **Query templates per resource kind (Q13):** built-in defaults shipped in
  code, overridable by key in the Klyx config (survives label-schema differences
  without a code change). Pod -> cpu/memory; HTTPRoute -> p50/p99/rps/5xx;
  Kustomization -> reconciliation duration; cluster aggregate -> cpu%/mem% for
  the fleet card.
- **Fleet-card cpu/mem source:** the same Prometheus endpoint (cluster-aggregate
  query), for one consistent metrics path. Fallback: Prometheus aggregate ->
  metrics-server (`metrics.k8s.io`) if Prom absent -> "no metrics" state.
- **Query discipline:** metrics are the one polled path (PromQL is
  request/response). Poll on a fixed cadence per *visible* resource, cache with
  the value timestamp, expose `{value, asOf}` so the UI shows staleness like
  informer data. Off-screen resources are not polled; nothing fans out on
  render.
- **Scale (Q12 ceiling):** fleet-aggregate metrics polled only for cards in the
  viewport (virtualised); tick interval widens as fleet size grows.
- **Isolation:** a dead Prom endpoint degrades only that cluster's metrics,
  never blocks cards or the fleet.

## 7. GitOps, drift, and the action boundary

Carries M3 and M6.

- **Separate models (principle 8):** `gitops/flux` and `gitops/argo` are
  distinct types. `flux.Kustomization` has `{revision, ready, drift}`;
  `argo.Application` has `{syncStatus, healthStatus, revision}`. No unified
  "GitOpsResource". The only shared field is an `owner` discriminator
  (`flux | argo | both`) for filtering and the split-brain check. UI reads
  "ready/drift" for Flux, "synced/degraded" for Argo.
- **Drift engine (live-vs-applied):** `drift.Differ` diffs the live object
  against the desired state Flux last applied, reconstructed from
  `kubectl.kubernetes.io/last-applied-configuration` when present, else from the
  field set owned by `kustomize-controller`/`helm-controller` in `managedFields`.
  Output is a structured per-field diff the UI renders as line-level YAML. Two
  baselines: a Flux-Kustomize path (annotation/managed fields) and a Helm path
  (rendered release manifest from the Helm storage secret).
- **Source resolution ("view in git"), separate concern:** `gitops/source`
  walks live resource -> owning Kustomization/HelmRelease -> `sourceRef`
  (GitRepository) -> `{url, revision, path}` and builds a best-effort deep link
  (GitHub/GitLab/Azure DevOps). It does not fetch or render Git; if resolution is
  incomplete (overlays obscure the exact file), it links to repo+path and says
  so rather than guessing a line.
- **Coexistence / split-brain (mockup 6):** flag any resource carrying both
  `kustomize.toolkit.fluxcd.io/name` and `argocd.argoproj.io/instance` as
  `conflict`. `coexistence.go` scans the eager GitOps set; no re-rendering, no
  heuristics.
- **Action boundary (principle 9):**
  - Reconcile / suspend / resume are allowed (they annotate, they do not
    template resources). Suspend gets a type-aware confirmation explaining the
    real effect (Q7: Kustomization stops reconciliation; HelmRelease stops
    upgrades).
  - Reconcile on a `prd`-tagged cluster requires an extra confirmation (Q8),
    keyed off the declared config tag.
  - "Resolve" on split-brain is **diagnose-only**, relabelled **"inspect
    conflict"**: shows both claims and applied manifests, explains the risk,
    links each owner to Git. It does not mutate. (Deviation from the mockup's
    wording, on principle grounds.)

## 8. M1 scope

M1 connects >=2 clusters from the config to exercise fan-out, failure
isolation, and staggered lazy connect; views stay minimal, the spine is
exercised honestly.

**Single-cluster is a first-class supported config.** With one cluster in the
config the user gets the full M1: the fleet view rendering one card (fleet-of-
one, no context gate), live card data (status, badges, nodes, metadata-only pod
count, GitOps summary), full capability detection, the degraded/unreachable
state, command palette, light/dark. Nothing is hidden behind "add more
clusters".

A single cluster cannot prove fan-out, failure isolation, concurrent
exec-plugin auth, or the multi-conn registry lifecycle - hence the >=2 bar is a
test/validation requirement, not a runtime one.

**M1 builds:**
- Wails v3 shell - sidebar, header, command palette (palette before sidebar,
  principle 6). Palette in M1: context switch + cluster jump.
- Klyx config loader + `cluster` connection layer with exec-plugin auth (AKS
  `kubelogin`, EKS `get-token`) - the concurrent-refresh path is part of the
  multi-cluster risk being de-risked.
- ClusterRegistry + ClusterConn with metadata-only eager set, state machine,
  staleness tracking.
- Capability detection - presence + health passes for Flux, Argo, Cilium,
  Gateway API.
- Fleet view - grid of cluster cards (mockup 1/4) with capability-driven
  rendering, loading skeleton, degraded/unreachable states.
- Light and dark mode, CSS variables, Tabler outline icons, mockup visual
  language.

**M1 defers / stubs:**
- Fleet-card metrics: the metrics layer interface exists and the capability
  reports `promEndpoint` state, but cpu/mem%/GPU% render a "metrics pending"
  state. Prometheus client lands as the immediately-following slice - keeps
  observability connectivity off M1's critical path without pretending it is an
  M7 concern.
- Drilldowns: no GitOps view, network graph, or CRD browser. Capability
  detection runs and the card reflects it; click-through is post-M1.
- All mutating actions - viewer-only in M1.

**M1 done-criteria (two tiers):**
- Functional (1 cluster): launch -> config -> connect one cluster -> live card
  with correct capability badges -> card degrades cleanly if it drops ->
  light/dark.
- Architectural (>=2 clusters): the above, plus one cluster made unreachable
  while others stay live (isolation), merged fleet state across conns (fan-out),
  concurrent exec-plugin credential refresh.

## 9. Error handling and testing

**Error handling is the architecture, not a bolt-on.** Every failure resolves to
a `ClusterConn` state plus a human reason on the card:
- Connection/auth errors (exec plugin fails, cred expired, unreachable) ->
  `Failed`; never panics the registry. exec-plugin invocation is sandboxed per
  conn with a timeout so a hung `kubelogin` cannot wedge the app.
- Watch drops mid-session -> `Stale` (keep last cache, badge age).
- Capability/metrics sub-failures are scoped to their capability state, not the
  whole card.
- Partial fan-out -> "M of N clusters answered".

**Testing (TDD throughout - tests before implementation):**
- Data layer against envtest / fake clientset: ClusterConn lifecycle, lazy-watch
  start/stop with TTL, state-machine transitions (fake informer source). envtest
  covers discovery + capability presence detection against installed CRDs.
- Capability detection: table-driven tests with CRD/discovery fixtures (Flux
  present-but-crashlooping, Gateway API v1beta1-only, Cilium without Hubble)
  asserting tiered state + reason.
- Drift differ: golden-file tests, live object + applied baseline (annotation
  path and Helm-storage path) -> expected structured diff. Highest-risk logic,
  most fixtures.
- Split-brain: fixture resources with both / one ownership label.
- Fan-out / isolation: registry test with N fake conns, one forced to error;
  assert others stay `Synced` and aggregate annotates the partial.
- Frontend: component tests for card states (skeleton/live/degraded/unreachable)
  + a dark-mode snapshot per view. No e2e harness in M1.
- All timestamps/staleness use a single injected clock for determinism.

## 10. Assumptions to validate before building M3/M6

These parts are designed but speculative until verified against a live cluster:

- **Drift baseline availability:** that `last-applied-configuration` and/or
  Flux-owned `managedFields` reliably reconstruct the applied desired state for
  both Kustomize- and Helm-managed objects. Verify on a real drifted resource
  before committing the differ.
- **Helm storage path:** that the rendered release manifest in the Helm storage
  secret is a usable baseline for HelmRelease-managed objects.
- **Source-link resolution:** Git deep-link accuracy across overlays and Helm
  value layering; accept repo+path fallback where exact line is unknowable.
- **ClusterMesh status signal:** the exact field(s) that confirm connected peers
  on the running Cilium version.
- **Prometheus label schema:** built-in PromQL templates against the actual
  Mimir label set; rely on config override where they differ.

## 11. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Fleet membership from Klyx-owned config | Explicit, portable, klyx-serve-shareable; declares env tags |
| 2 | Metrics via per-cluster ingress endpoint + token | Uniform PromQL client, no per-provider auth |
| 3 | Drift = live-vs-applied (SSA/managed fields) | Vocabulary-correct; no Git/SOPS dependency |
| 4 | Resolve = diagnose-only ("inspect conflict") | Principle 9 (viewer, not control plane) |
| 5 | M1 >=2 clusters as validation bar; 1 supported at runtime | De-risks the differentiator without gating single-cluster users |
| 6 | Metadata-only informers for eager set | Controls fleet cache memory at scale |
| 7 | Aggregation at data layer, not view layer | Knows connection state, handles partial failure |
| 8 | Tiered capability states (Absent/Degraded/Healthy) | Presence-only lies about readiness |
| 9 | Fleet-card metrics deferred out of M1 | Keeps Prom reachability off M1 critical path |
