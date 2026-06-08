# Klyx M7-c-ii-a: Workloads health view — design

> Milestone M7-c-ii is split into two native-verification gates:
> **M7-c-ii-a** (this spec) — the Workloads health view from Kubernetes state
> only, no Prometheus required; and **M7-c-ii-b** (later) — cpu/mem usage +
> usage-vs-requests/limits layered on top, reusing the M7-a/b metrics substrate.
> The split mirrors M5 (structure) → M7-b (metrics): the health view is useful
> even when Prometheus is down, and gives the metrics layer a clean surface to
> enrich.

## Goal

A per-cluster **Workloads health view**: a triage-first list of Deployments,
StatefulSets, and DaemonSets that floats operational pain to the top — broken
and degraded workloads first, with the failing pod's reason, restart counts, and
owning GitOps object — with an inline pod drill-down. It answers two questions in
sequence: *what workload is unhealthy?* then *which pod is causing it?*

## Product philosophy (governing constraint)

Klyx surfaces a Kubernetes resource only through a **diagnostic lens** — health,
ownership, traffic path, policy, observability, or failure context — never as a
generic kind table. This view is the *workload health lens*, not a Deployments
browser. It is explicitly **not** the first tab of a resource zoo.

**Out of scope (by design):**
- No generic kind-tree (ConfigMaps / Secrets / Roles / ServiceAccounts tables).
- No logs or events — those are a later **diagnosis** milestone.
- No live-object editing (desired state stays in Git).
- No cpu/mem metrics (that is M7-c-ii-b).
- No Argo ownership (the owner runs Flux; Argo deferred per the roadmap).

## The triage layout

A flat list, sorted worst-first (not grouped by namespace — namespace is a
filter, not the primary axis; namespace-grouping is a later sort-mode toggle).
Row anatomy:

```
dot · kind · namespace · workload · ready · restarts · status · gitops owner
```

Example (sorted by health rank):

```
● deploy  ollama-prod  ollama        0/1  7  CrashLoopBackOff       flux ks/ollama
● deploy  console-dev  moomora-...    1/2  0  Progressing · 1 unavail flux ks/console-dev
○ deploy  monitoring   grafana        1/1  0  Available              flux ks/monitoring
○ sts     monitoring   prometheus     1/1  0  Ready                  flux ks/monitoring
○ daemonset kube-system cilium        5/5  0  Ready                  —
```

Clicking a row expands it inline to its pods:

```
▾ deploy ollama-prod ollama  0/1  7  CrashLoopBackOff
    pod                       ready restarts reason            node          age
    ollama-7c9f9d8b6f-x2k9p   0/1   7        CrashLoopBackOff  homelab-nelli 12m
```

## Architecture

```
fleet (*ClusterConn).ListWorkloads(ctx, namespace)
   │  typed lists: AppsV1 Deploy/STS/DS + CoreV1 Pods, scoped to namespace at source
   │  reads caps.GitOps.Flux.Present
   ▼
internal/workloads.Assemble(deploys, stss, dss, pods, fluxPresent) []Workload
   │  pure: Classify (per kind) · selector-join pods · WorstPodReason · RankOf
   │        · owner extraction · sort
   ▼
appbridge WorkloadsService.ListWorkloads(cluster, namespace) → WorkloadsResultDTO
   ▼
store workloads slice → WorkloadsView (filters · triage rows · inline pod expand)
```

### `internal/workloads` (new pure package)

Operates on typed `k8s.io/api/apps/v1` + `core/v1` objects (plain structs, no
client) — fully fixture-testable, same spirit as `internal/gwapi`.

```go
type HealthRank int // sort order: lower = worse = nearer the top
const (
	Unhealthy HealthRank = iota // ready==0 (desired>0) OR a hard failure reason
	Degraded                    // ready<desired, rolling out / benign, no hard failure
	Restarts                    // ready==desired, but a container terminated recently (<1h) (info)
	Healthy                     // ready==desired, no recent termination (incl. desired==0 "Scaled to 0")
)

type Owner struct {
	Kind, Namespace, Name string // "Kustomization"/"HelmRelease"; from Flux labels
}

type Pod struct {
	Name       string
	Ready      bool
	Restarts   int
	Reason     string // worst container/pod reason, "" if running clean
	Node       string
	AgeSeconds int // derived in Assemble from (now - creationTimestamp); never time.Now() downstream
}

type Workload struct {
	Kind, Namespace, Name              string // Kind: "Deployment"/"StatefulSet"/"DaemonSet"
	Desired, Ready, Available, Updated int
	Restarts                           int    // summed across the workload's pods
	Reason                             string // single human-facing status string
	Rank                               HealthRank
	GitOps                             *Owner // nil when no Flux label / Flux absent
	Pods                               []Pod  // the matched pods (for inline expand)
}

// Assemble joins workloads with their pods and derives health. fluxPresent gates
// owner extraction. Returns workloads pre-sorted by (Rank, Namespace, Name).
func Assemble(deploys []appsv1.Deployment, stss []appsv1.StatefulSet,
	dss []appsv1.DaemonSet, pods []corev1.Pod, fluxPresent bool, now time.Time) []Workload
```

**Per-kind Classify** (desired/ready/available/updated + condition reason):
- **Deployment:** desired = `*spec.replicas` (nil→1); ready = `status.readyReplicas`;
  available = `status.availableReplicas`; updated = `status.updatedReplicas`.
  Condition priority for the reason: `ReplicaFailure=True` → its reason; else
  `Available=False` → its reason; else `Progressing=False` → its reason; else
  `Progressing=True` with reason ≠ `NewReplicaSetAvailable` → "Rolling out".
  A healthy deployment's `Progressing/NewReplicaSetAvailable` is NOT surfaced as
  a noisy status.
- **StatefulSet:** desired = `*spec.replicas` (nil→1); ready = `status.readyReplicas`;
  available = `status.availableReplicas`; updated = `status.updatedReplicas`;
  `currentRevision != updateRevision` → rolling out.
- **DaemonSet:** desired = `status.desiredNumberScheduled`; ready = `status.numberReady`;
  available = `status.numberAvailable`; updated = `status.updatedNumberScheduled`;
  `numberUnavailable > 0` → degraded, condition reason `Degraded · N unavailable`
  (same style as Deployment's `Progressing · N unavailable`).

**Selector-join (pods → workload):** use the workload's `spec.selector`
(`metav1.LabelSelector` → `labels.Selector`) matched against pod labels, **same
namespace only**. **An empty/nil selector matches ZERO pods** (never the whole
namespace). Owner-reference confirmation is a possible future safety check; for
this slice, selector-match is the join. For each matched pod: `Ready` from the
`PodReady` condition; `Restarts` = sum of `containerStatuses[].restartCount`;
`Node` = `spec.nodeName`; `AgeSeconds` = `now - metadata.creationTimestamp`
(using the `now` passed into `Assemble`, so it is deterministic and the
appbridge never calls `time.Now()` for age).

**WorstPodReason** — across the workload's matched pods, the worst single reason
by precedence (reads container statuses AND pod phase/conditions, since
scheduling failures live at pod level):

1. **Hard failures (rank Unhealthy):** container waiting `CrashLoopBackOff`;
   `lastState.terminated.reason == OOMKilled` (ranked high even if currently
   running — it explains restarts); `ImagePullBackOff` / `ErrImagePull`;
   `CreateContainerConfigError` / `CreateContainerError` / `InvalidImageName`;
   pod `PodScheduled=False` → `Unschedulable`; pod `phase == Failed` → its reason.
2. **Benign/transient (does not itself force Unhealthy):** `ContainerCreating`,
   `PodInitializing`.
3. **None:** `""` (all containers running clean).

The worst hard-failure reason wins; the precedence order within (1), highest
first, is: `CrashLoopBackOff` > `OOMKilled` > `ImagePullBackOff` / `ErrImagePull`
> `CreateContainerConfigError` / `CreateContainerError` / `InvalidImageName` >
`Unschedulable` > `phase==Failed`. Any reason in (1) sets rank Unhealthy; the
order only decides which string is displayed when a workload's pods exhibit more
than one distinct hard failure. The plan pins this order in a table test.

**RankOf:**
- `Unhealthy` if `desired>0 && ready==0`, OR a hard-failure WorstPodReason is present.
- else `Degraded` if `ready < desired` (rolling out, benign, or simply not-yet-available).
- else `Restarts` if `desired>0 && ready==desired` AND a container (init or main)
  terminated within the last hour (`recentlyTerminated`, reading
  `lastState.terminated.finishedAt` / `state.terminated.finishedAt`). The info tier
  is recency-gated so a long-lived cluster does not show a wall of blue from
  restarts that happened weeks ago. The restart COUNT stays in its own column
  regardless. A stale historical reason (old OOMKill/Error) is suppressed from the
  row status text so a grey/healthy row never reads "OOMKilled".
- else `Healthy` (`ready==desired`, no recent termination). `desired==0` lands here.

**Reason (display string)**, in order — the `desired==0` rule dominates so a
scaled-down workload with a stale condition never shows something noisier:
1. `desired==0` → `Scaled to 0`.
2. else WorstPodReason if present.
3. else the Classify condition reason (`Rolling out · N updated` /
   `Progressing · N unavailable` / `Degraded · N unavailable` / a failure reason).
4. else `Available` (Deployment) / `Ready` (STS/DS).

**Owner extraction** (only when `fluxPresent`): from workload labels —
`kustomize.toolkit.fluxcd.io/name` + `…/namespace` → `Owner{Kind:"Kustomization"}`;
`helm.toolkit.fluxcd.io/name` + `…/namespace` → `Owner{Kind:"HelmRelease"}`.
nil otherwise. The claim is **"carries this Flux ownership label,"** not "owned
by a verified-healthy object."

### Fleet

```go
// ListWorkloads lists Deploy/StatefulSet/DaemonSet + Pods scoped to namespace
// ("" = all namespaces; a set namespace scopes the typed list at source), and
// assembles their health. On-demand; no watch.
func (c *ClusterConn) ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, error)
```
Reads `c.caps.GitOps.Flux.Present` under the snapshot lock for `fluxPresent`.
Added to the `Conn` interface.

### Appbridge

```go
type WorkloadsConn interface {
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, error)
}

type OwnerDTO struct {
	Kind, Namespace, Name string
}
type PodDTO struct {
	Name       string `json:"name"`
	Ready      bool   `json:"ready"`
	Restarts   int    `json:"restarts"`
	Reason     string `json:"reason"`
	Node       string `json:"node"`
	AgeSeconds int    `json:"ageSeconds"`
}
type WorkloadDTO struct {
	Kind, Namespace, Name              string
	Desired, Ready, Available, Updated int
	Restarts                           int
	Reason                             string
	Rank                               string // pinned API values, lowercase: "unhealthy" | "degraded" | "restarts" | "healthy" (no title-case, no UI wording)
	GitOps                             *OwnerDTO
	Pods                               []PodDTO
}
type WorkloadsResultDTO struct {
	FluxPresent bool          `json:"fluxPresent"`
	Namespaces  []string      `json:"namespaces"` // populated ONLY when namespace=="" (dropdown source)
	Workloads   []WorkloadDTO `json:"workloads"`
}

func (s *WorkloadsService) ListWorkloads(cluster, namespace string) WorkloadsResultDTO
```
`Workloads` and `Namespaces` are always non-nil (JSON `[]`, not null). Lookup
seam (`func(string)(WorkloadsConn,bool)`), 30s ctx, registered in `main.go`.
`Namespaces` is the sorted distinct set of workload namespaces seen, populated
only on the all-namespaces load.

### Frontend

New `workloads` cluster section — four nav touch points (Sidebar icon entry,
`ClusterSection` union, `SECTION_LABELS`, `ClusterDetail` switch case).

`WorkloadsSlice`:
```ts
type WorkloadsSlice = {
  cluster: string | null;
  namespace: string;            // "" = all
  items: WorkloadDTO[];
  namespaces: string[];         // dropdown options; preserved across scoped refetches
  fluxPresent: boolean;
  loading: boolean;
  kindFilter: Record<"Deployment"|"StatefulSet"|"DaemonSet", boolean>;
  needsAttention: boolean;      // filter: show only rank != healthy
  expanded: Set<string>;        // keys "<kind>/<namespace>/<name>"
};
```
Setter rule (namespace-list preservation): on a result with `namespace==""`,
replace `namespaces` from `result.namespaces`; on a scoped result
(`namespace!=""`), **keep the previous `namespaces`** so the dropdown stays full.
**Fallback** (first load was scoped, so `namespaces` is empty): if `namespaces`
is empty after a scoped result, seed it with `[currentNamespace]` so the dropdown
has at least the active option until an all-namespaces load (selecting "all
namespaces") populates the full list. No extra backend call.

`WorkloadsView.tsx`:
- **Filter bar:** namespace `<select>` (options = `namespaces`; choosing one sets
  `namespace` and triggers a **source-scoped re-fetch**), kind chips (client-side
  toggle), a **"needs attention"** toggle (client-side, `rank != "healthy"` —
  includes unhealthy, degraded, AND restarts so it means "things worth looking
  at"), and a **Refresh** button.
- **Rows** arrive pre-sorted from `Assemble`; dot colour + status from `rank`/
  `reason`. Columns per the anatomy above. The row is obviously clickable.
- **Inline expand:** clicking toggles the key `<kind>/<namespace>/<name>` in
  `expanded`; expanded rows render a pods sub-table (name·ready·restarts·reason·
  node·age). Default collapsed; unhealthy floats to top but is NOT auto-expanded.
- **GitOps owner:** compact `flux ks/<name>` (or `hr/<name>`); tooltip the full
  `Flux ownership label: Kustomization <ns>/<name>` (claims the label, not owner
  health). `—` when `gitops` is null.

## Honesty model

- **No "not installed" gate:** apps/v1 is always served, so the view always
  renders. Empty result → "no workloads in `<namespace>`".
- **Scaled-to-zero ≠ broken:** `desired==0` → `0/0 · Scaled to 0 · healthy`
  (muted), never red. (Common false-alarm sin; explicitly prevented.)
- **Restarts are real:** summed across the workload's pods; `0` is a real 0; the
  `Restarts` rank is an *info* state, not a warning. (A future refinement could
  age restarts via `lastState.terminated.finishedAt`; not in this slice.)
- **Worst-reason is "—"** when all containers run clean; the status then falls
  back to the workload condition.
- **GitOps claim is small:** "carries Flux ownership label," surfaced only when
  Flux capability is present; `—` otherwise. Never asserts the owner is healthy.
- **Empty/nil selector matches no pods** — a workload with no selector shows
  `ready/desired` from its status and an empty pod list, never the whole namespace.

## Lifecycle

On-demand: fetch on view mount and on manual **Refresh**. Namespace change
re-fetches **scoped at source**. Kind filter, "needs attention", and row expand
are **client-side** (no re-fetch). Expand state is preserved across client-side
filter changes and reset on a re-fetch. No watch; a short cache is a possible
later optimization, not in this slice.

## Testing

- `internal/workloads` (pure, the bulk of the tests):
  - `Classify` per kind from status fixtures → desired/ready/available/updated and
    the condition-priority reason (incl. a healthy Deployment NOT showing a noisy
    Progressing status; `ReplicaFailure`/`Available=False`/`Progressing=False`
    precedence).
  - `WorstPodReason` precedence table: CrashLoopBackOff, OOMKilled-from-lastState
    (ranks high while running), ImagePullBackOff/ErrImagePull, CreateContainer*,
    Unschedulable (PodScheduled=False), phase==Failed, benign ContainerCreating,
    and clean → "".
  - selector-join: matches by selector + same namespace; **empty selector → zero
    pods**; restart summation; ready-pod counting.
  - `RankOf`: the 4 ranks + `desired==0` → Healthy "Scaled to 0".
  - `Assemble`: sort order (Rank then ns/name), owner extraction with/without
    `fluxPresent`, multi-kind mix.
- `internal/fleet`: `ListWorkloads` against a fake clientset (deploy/sts/ds +
  pods, healthy + broken) → assembled/sorted; namespace scoping passes through.
- `internal/appbridge`: DTO mapping (nested pods, owner, nil owner, `Namespaces`
  only on all-load, non-nil slices, `AgeSeconds` passed through from the model),
  and a test pinning the exact rank strings `"unhealthy"|"degraded"|"restarts"|
  "healthy"` (lowercase, no UI wording).
- frontend: triage sort render + dot colours; kind / needs-attention filters;
  namespace change triggers re-fetch; pod expand by `<kind>/<ns>/<name>` key;
  GitOps owner compact + tooltip; scaled-to-zero row; empty state; dropdown
  namespace-list preserved across a scoped re-fetch.

## Native verification (homelab-nelli)

The cluster is healthy, so verification deploys deliberate failures in a
`klyx-test` namespace, then cleans up:

1. **Bad image** (`image: does-not-exist:nope`) Deployment → row shows
   `0/1 · ImagePullBackOff`, red dot, **floated to the top**; expand shows the
   failing pod with its node and age. Validates pod-reason extraction, rank,
   sort, inline expand.
2. **Scaled to zero** (`kubectl -n klyx-test scale deploy/<name> --replicas=0`) →
   row shows `0/0 · Scaled to 0`, muted/healthy, **not** red. Validates the
   false-alarm guard.
3. A **Flux-managed** workload (e.g. `monitoring/grafana`) shows `flux ks/<name>`
   with the full tooltip; a non-Flux workload shows `—`.
4. **Namespace filter** scoped to `monitoring` re-fetches and shows only that
   namespace; the dropdown still lists all namespaces.
5. **Restarts** surface on any workload whose pods have restarted; `0` elsewhere.

## File structure

- Create: `internal/workloads/{model.go,classify.go,reason.go,assemble.go,*_test.go}`.
- Modify: `internal/fleet/workloads.go` (new) — `ListWorkloads`; `internal/fleet/conn.go`
  (interface).
- Create: `internal/appbridge/workloads_service.go`, `workloads_dto.go` (+ test).
- Modify: `cmd/klyx/main.go` (register `WorkloadsService`).
- Create: `cmd/klyx/frontend/src/bridge/workloads.ts`, `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`.
- Modify: `cmd/klyx/frontend/src/store/fleet.ts` (slice + section), `chrome/Sidebar.tsx`,
  `cluster/ClusterDetail.tsx`.

## Decisions log

1. Two gates: M7-c-ii-a = k8s-only health view (this); M7-c-ii-b = cpu/mem metrics.
2. Triage-first flat list (unhealthy → degraded → restarts → healthy → ns/name),
   namespace as a filter not the primary axis; namespace-grouping is a later toggle.
3. Full-triage fetch: Deploy/STS/DS + all pods (on-demand, no watch), scoped at
   source by namespace; pods power the unhealthy-first sort and the inline expand.
4. Pure `internal/workloads` package does classify/join/reason/rank/sort/owner;
   fleet only fetches.
5. `Updated` defined per kind; ready≠updated during rollouts.
6. Selector-join, same-namespace; empty/nil selector matches zero pods.
7. `WorstPodReason` reads pod phase/conditions + container statuses;
   OOMKilled-from-lastState ranks high.
8. Deployment condition priority: ReplicaFailure → Available=False →
   Progressing=False → rollout; healthy Progressing is not surfaced.
9. Health-rank `Restarts` is a recency-gated info state: only a container
   termination within the last hour lights it; the total restart count stays
   visible in its own column regardless.
10. GitOps owner = Flux ownership label, surfaced only when Flux present;
    compact in row, full in tooltip; never claims verified owner health.
11. `desired==0` → Healthy "Scaled to 0" (no false red).
12. Inline pod expand is render-only (pods already fetched); key
    `<kind>/<namespace>/<name>`; default collapsed; expand preserved across
    client-side filters.
13. "Needs attention" filter = `rank != healthy` (unhealthy/degraded/restarts).
14. Namespace dropdown options preserved across scoped re-fetches (response
    carries `Namespaces` only on the all-namespaces load).
