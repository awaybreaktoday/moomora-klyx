# Klyx M10 design (Flux diagnosis depth)

Date: 2026-06-17
Status: approved design, ready for plan
Scope: M10, an enhancement of the M3 Flux work. Makes Klyx able to *diagnose a
stuck Flux resource without dropping to a terminal*. Five parts (M10-a..e), each
shippable on its own, all read or day-2-drive (never authors desired state -
CLAUDE.md non-goal holds). Builds on M3-a (listing), M3-b (resource detail +
inventory), M3-c (actions), M3-d (view in Git).

## 1. Context: the gap M10 closes

M3 covers the "is it green, kick it if not" loop: a broken-first list of
Kustomizations + HelmReleases, an inline detail panel (conditions, inventory,
revisions, apply-failure flag), and Reconcile / Suspend / Resume / View-in-Git.

What it does not cover is *why* a resource is not green. Validated against the
homelab and the six AKS clusters, the four most common real failure modes are:

1. **The source is not pulling.** A `GitRepository` / `OCIRepository` with a
   failing `Ready` (auth, revision-not-found, TLS) is the root cause, but Klyx
   only fetches sources on-demand for link resolution (`gitopssource.go`) and
   never shows their health. The Kustomization shows "reconciling" forever.
2. **The failing condition is opaque.** `common()` reads only the `Ready`
   condition's message into the row. The *reason* (`UpgradeFailed`,
   `ArtifactFailed`, `DependencyNotReady`, `HealthCheckFailed`) - the one word
   that tells you where to look - is dropped.
3. **It is blocked on a dependency.** Neither backend nor UI parse
   `spec.dependsOn`. A Kustomization stuck `reconciling` is often just waiting on
   `infra-controllers`, not broken - indistinguishable today from a real stall.
4. **What the controller actually did is invisible.** The only drift signal
   today is `applyFailed` (derived from `attempted != applied`), which is *apply
   failure*, not drift. Flux auto-heals drift on every reconcile (server-side
   apply each interval), so a *standing* live-vs-Git divergence does not exist on
   a healthy Kustomization - what persists is the controller's **record that it
   corrected something**: Kubernetes Events on the resource (drift corrections,
   health-check failures, dependency-not-ready) that Klyx never surfaces. The
   durable drift signal is in the API, not in a reconstructed diff.

M10 closes all four, plus the day-2 action that pairs with (1).

### 1.1 Drift: rely on what Flux reports, render a diff only on demand

A field-level live-vs-Git diff is the wrong default. Because Flux re-applies
desired state every interval, a Git-rendered diff of a healthy Kustomization
comes back empty - the divergence was already healed. The persistent, truthful
drift signal is therefore **read from Flux's own telemetry** (Events naming the
corrected objects + Conditions + the Inventory we already parse), which needs no
Git fetch, no SOPS/KMS decryption, and no per-cloud credentials - so it works
identically across homelab, EKS, AKS, and GKE for free.

A real Git-rendered diff only shows something Flux's reports cannot in three
narrow cases: a **suspended** Kustomization (Flux is not applying, so live can
genuinely diverge with no correcting event), an **apply-failing** one (Flux wants
to apply but a field is immutable / dry-run-rejected), and **pre-merge preview**
(out of scope here). M10 therefore makes the event/condition/inventory read the
**default drift surface** (M10-e) and offers `flux diff` as an **on-demand action
scoped to suspended / apply-failing resources** (M10-f) - so the SOPS / KMS /
multi-cloud-credential complexity only engages when a human asks for a real diff
on a resource where it is actually informative, never on the hot path.

## 2. Scope and honest boundaries

In scope:
- **M10-a Source health.** Watch the Flux source kinds (`GitRepository`,
  `OCIRepository`, `Bucket`, `HelmRepository`, `HelmChart`) alongside ks/hr.
  Surface the *bound source's* Ready state, fetched revision, and message in a
  resource's detail panel, and add a "sources" filter to the list.
- **M10-b Reconcile with source.** A day-2 action equivalent to
  `flux reconcile <kind> <name> --with-source`: stamp the reconcile annotation on
  the resource *and* its bound source. Behind the same ConfirmDialog + prd-lock
  path as the existing Reconcile.
- **M10-c Failure-reason surfacing.** Carry the `Ready` condition's `reason`
  through to the row + inspector header as a short chip (`UpgradeFailed`,
  `DependencyNotReady`, ...).
- **M10-d dependsOn blocked-by.** Parse `spec.dependsOn`; render a "depends on"
  section in the detail panel with each dependency's resolved Ready state
  (resolved frontend-side from the already-loaded resource list); promote a
  "blocked by `<dep>`" line when the resource's reason is `DependencyNotReady`.
- **M10-e Drift surface (read Flux's telemetry).** The default drift view: read
  core/v1 Events whose `involvedObject` is the Flux resource and render the last N
  (type, reason, age, message) in the detail panel, flagging drift corrections
  (`reason`/message indicating an object was reconfigured) as the drift signal and
  `Warning` events in danger styling, cross-referenced against the parsed
  Inventory. No Git fetch, no decryption, multi-cloud for free.
- **M10-f On-demand `flux diff` (escape hatch).** A user-triggered "compute diff"
  action, surfaced only on **suspended** or **apply-failing** resources (the cases
  where a real diff shows what telemetry cannot). Shells out to
  `flux diff kustomization <name> --path <path>` (clone + local build +
  server-side dry-run), parses the output into an inline diff. The CLI inherits
  the shell's per-cloud auth, so SOPS via age/GPG, AWS KMS, Azure Key Vault, and
  GCP KMS all work with no provider-specific code in Klyx. Degrades with a clear
  message when `flux`/`git` are unavailable or auth/decrypt is denied. Never on
  the hot path; never run automatically.

Explicitly NOT in M10 (documented):
- **No always-on / native Git-render diff engine.** Rejected by design (§1.1):
  Flux heals drift, so a default diff is empty and misleading, and a native engine
  would re-implement SOPS + AWS/GCP/Azure KMS that the `flux` CLI already solves.
  The on-demand `flux diff` escape hatch (M10-f) covers the cases that need it.
- **No pre-merge / branch preview diff** - a later, separate feature.
- **No image-automation kinds** (`ImageRepository`/`ImagePolicy`/
  `ImageUpdateAutomation`) - Tier 2, gated on whether the owner runs them.
- **No notification-controller console** (`Alert`/`Provider`/`Receiver`) - bumps
  the "not an alerting platform" non-goal. Reading a `Receiver` URL for
  debugging is fine; an alert UI is not.
- **No per-inventory-object live readiness** (kstatus) - still M3-b's deferral.

## 3. Data layer

### 3.1 `internal/gitops/flux` - source parser + extended resource fields

New pure parsing, no Flux Go API dependency (tolerant of version drift, same as
the rest of the package).

```go
// Source kinds Klyx watches + acts on.
const (
    GitRepositoryKind  Kind = "GitRepository"
    OCIRepositoryKind  Kind = "OCIRepository"
    BucketKind         Kind = "Bucket"
    HelmRepositoryKind Kind = "HelmRepository"
    HelmChartKind      Kind = "HelmChart"
)

// Source is a Flux source object's fetch state (status.artifact + Ready).
type Source struct {
    Kind      Kind
    Namespace string
    Name      string
    Ready     ReadyState   // reuse Ready/Reconciling/Failed/Unknown
    Reason    string       // Ready condition reason (e.g. GitOperationFailed)
    Message   string
    Revision  string       // status.artifact.revision (the fetched artifact)
    URL       string       // spec.url (empty for HelmChart)
    Suspended bool
}

func ParseSource(u *unstructured.Unstructured) Source
```

`ParseSource` reuses the condition walk from `common()` (Ready state + reason +
message + Reconciling), then reads `status.artifact.revision` and `spec.url`.

Two existing types gain fields (additive, json-additive on the DTOs):
- `Resource.Reason` (string) - the `Ready` condition's reason, set in `common()`
  alongside `Message`. Feeds M10-c.
- `Resource.DependsOn []DependencyRef` and `Detail.DependsOn []DependencyRef`
  where `DependencyRef struct { Namespace, Name string }`, parsed from
  `spec.dependsOn` (namespace defaults to the resource's own namespace). Feeds
  M10-d. Parsed in `common()` (cheap) so the list-level resolution has it too.

### 3.2 `internal/fleet` - watch the sources, expose them

`gitopsWatch` gains one informer per source kind (lazy, same factory as ks/hr).
`OpenGitOps` resolves each source GVR via `preferredVersion` (fallbacks:
GitRepository v1, OCIRepository v1beta2, Bucket v1, HelmRepository v1,
HelmChart v1).

New methods on `ClusterConn` (added to the appbridge `GitOpsConn` interface +
the test `fakeConn`/`fakeGitOpsConn` stubs):

```go
func (c *ClusterConn) GitOpsSources() []flux.Source
func (c *ClusterConn) GitOpsSourceObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
func (c *ClusterConn) ReconcileWithSource(ctx, kind, ns, name string) error          // M10-b
func (c *ClusterConn) FluxEvents(ctx, kind, ns, name string) ([]flux.Event, error)   // M10-e
```

- `GitOpsSources` lists all five source stores, parsed + sorted (kind rank then
  ns/name), pushed on the existing `gitops:updated` tick.
- `ReconcileWithSource` resolves the resource's bound source
  (`flux.BoundSource(u)` - sourceRef for ks, chart.spec.sourceRef / chartRef for
  hr), stamps the reconcile annotation on the source object first (via its source
  GVR, extended `sourceGVR` in `gitopssource.go`), then on the resource. If the
  source can't be resolved it degrades to a plain reconcile (so the action never
  hard-fails on an unusual source).
- `FluxEvents` lists core/v1 Events filtered to
  `involvedObject.kind/name/namespace == this resource`, newest first, capped
  (e.g. 25). Reuses the events plumbing in `internal/fleet/events.go`. This is the
  default drift surface (M10-e): the controller's own record of what it corrected.

`sourceGVR(kind)` in `gitopssource.go` is extended from GitRepository-only to all
five source kinds (the existing `SourceURL` keeps working unchanged).

### 3.3 `internal/fleet` + `internal/fluxcli` - on-demand `flux diff` (M10-f)

The diff is a shell-out, not a watch or a parser - it lives behind a CLI wrapper
modelled on `internal/helmcli` (which already wraps the `helm` binary and resolves
PATH via `internal/execenv`):

```go
// internal/fluxcli
func Available() bool                                   // `flux` on PATH
type DiffResult struct { Output string; HasChanges bool; Err string }
func DiffKustomization(ctx, kubeconfig, context, ns, name, path string) DiffResult
```

```go
// ClusterConn - gated so the UI only offers it where a real diff is informative
func (c *ClusterConn) FluxDiffKustomization(ctx, ns, name string) (DiffResult, error)
```

`FluxDiffKustomization` reads the live Kustomization for `spec.path` + the bound
source, then invokes `fluxcli.DiffKustomization` with the cluster's kubeconfig +
context (so the CLI auths exactly as Klyx's connection does, and inherits the
shell's per-cloud creds for SOPS/KMS). It is **only called for suspended or
apply-failing resources** - the service refuses (clear message) otherwise, so the
escape hatch can never be the default path. `flux`/`git` absent → `Available()`
false → the button is hidden, not errored.

> Note: there is no `flux diff helmrelease`. For HelmReleases M10-f is not offered;
> their drift story stays the telemetry read (M10-e). A `helm diff`-based path is a
> possible later follow-up, out of scope here.

## 4. appbridge

New/extended DTOs (json-additive):

```go
type FluxSourceDTO struct {
    Kind, Namespace, Name, Ready, Reason, Message, Revision, URL string
    Suspended bool
} // sources pushed in the gitops:updated payload alongside resources

type DependencyRefDTO struct { Namespace, Name string }
type FluxEventDTO struct { Type, Reason, Message, Age string; CountInt int }

// FluxResourceDTO gains: Reason string, DependsOn []DependencyRefDTO
// ResourceDetailDTO gains:
//   Reason string
//   DependsOn []DependencyRefDTO
//   Source   *FluxSourceDTO   // the bound source's health, resolved on detail read
//   Events   []FluxEventDTO   // M10-e, last N reconciliation events
```

- The `gitops:updated` payload gains `sources []FluxSourceDTO` (one push carries
  both - the UI resolves a resource's bound source from this list for the row,
  and `GetResourceDetail` embeds the full bound `Source` for the panel).
- `GetResourceDetail` additionally resolves the bound source object
  (`GitOpsSourceObject`) → `Source`, and calls `FluxEvents` → `Events`. Both are
  cheap store/list reads; still request/response on expand + each tick.
- New bound method `ReconcileWithSource(cluster, kind, ns, name) ActionResultDTO`
  mirroring `Reconcile`.
- New bound method (M10-f) `FluxDiff(cluster, ns, name) FluxDiffDTO` where
  `FluxDiffDTO struct { Available bool; HasChanges bool; Output string; Error string }`.
  Request/response, invoked only when the user clicks "compute diff"; `Available`
  false hides the affordance. Not pushed, never auto-run.

## 5. Frontend

- Store `FluxResourceDTO` gains `reason`, `dependsOn`; `ResourceDetailDTO` gains
  `reason`, `dependsOn`, `source`, `events`. New `FluxSourceDTO`,
  `DependencyRefDTO`, `FluxEventDTO` types. The gitops slice gains
  `sources: FluxSourceDTO[]`; `setGitOps` takes `(cluster, resources, sources)`.
- `bridge/gitops.ts`: the `gitops:updated` handler stores `sources`;
  `reconcileWithSource(...)` wired to the new bound method.
- `GitOps.tsx`:
  - **M10-a** New "sources" filter button + when active the list renders sources
    (kind chip `git`/`oci`/`bucket`/`helmrepo`/`chart`, fetched revision, Ready).
    In the detail panel a **Source** section shows the bound source's Ready dot +
    revision + message; a failing source is the headline ("source not ready:
    `<reason>`").
  - **M10-b** A "Reconcile with source" button next to Reconcile (same
    ConfirmDialog, prd-lock aware).
  - **M10-c** A small reason chip on the row (next to the ks/hr tag) and in the
    inspector header when `reason` is set and the resource needs attention.
  - **M10-d** A **Depends on** section listing each dep with a resolved Ready dot
    (resolved from `gitops.resources`); a danger "blocked by `<dep>`" line when
    `reason === "DependencyNotReady"`.
  - **M10-e** A **Drift / events** section (the default drift surface): last N
    events as `<reason> · <age>` + message, `Warning` in danger colour, drift
    corrections (object reconfigured) flagged as the drift signal and
    cross-referenced to the Inventory. Reuses the Section/Muted primitives.
  - **M10-f** A **Compute diff** button shown *only* when the resource is
    suspended or apply-failing. Click → `FluxDiff` → render the diff inline (mono,
    add/remove colouring) or "no changes"; when `available` is false the button is
    hidden; on error show the CLI message (e.g. "flux not found", "decrypt
    denied"). A short caption notes it shells out to `flux diff` with your local
    credentials.
- Visual language unchanged (tokens, mono identifiers, status colours, the
  list+inspector two-pane layout from M3-b).

## 6. Testing

- **flux `ParseSource`:** fixtures for each source kind - Ready true/false with
  reason, `status.artifact.revision`, `spec.url`; a suspended source.
- **flux `common` reason + dependsOn:** a ks fixture with
  `reason: DependencyNotReady` and a `spec.dependsOn` of two refs (one with an
  explicit namespace, one defaulting) → assert `Reason` + `DependsOn`.
- **flux `BoundSource`:** ks (sourceRef), hr (chart.spec.sourceRef), hr (chartRef)
  → assert kind/name/namespace resolution.
- **fleet:** seed the dynamic fake with a GitRepository + a Kustomization → assert
  `GitOpsSources` returns the source; `ReconcileWithSource` patches both objects
  (assert the annotation on each); `FluxEvents` filters by involvedObject.
- **appbridge:** `GetResourceDetail` embeds the bound `Source` + `Events`;
  `ReconcileWithSource` OK + cluster-miss error paths.
- **fluxcli (M10-f):** `Available()` reflects `flux` on PATH; `DiffKustomization`
  parses CLI exit codes (`flux diff` exits non-zero with output when there are
  changes) into `HasChanges` vs a real error; covered with a fake-exec seam like
  `helmcli`'s tests. Service-level: `FluxDiff` refuses (clear message) on a
  healthy/non-suspended resource.
- **frontend:** sources filter renders a source row; detail panel shows a failing
  source headline, a reason chip, a dependsOn blocked-by line, and an event row;
  "Reconcile with source" opens the confirm and calls the bridge; the "compute
  diff" button shows only on suspended/failing resources and renders the diff.
- **Native handoff:** drill `homelab-nelli` and an AKS/EKS/GKE cluster → Flux →
  expand a Kustomization: source health, reason chip, dependsOn, and the drift /
  events surface render; "Reconcile with source" re-pulls; on a *suspended*
  Kustomization "compute diff" shells out and shows a real diff (verifying SOPS via
  the local cloud identity across providers). Owner eyeball confirms.

## 7. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Source health surfaced in the resource's detail (bound source), not only a standalone list | The diagnostic question is "is *this* resource's source pulling" - answer it where you're already looking |
| 2 | Watch the five source kinds via the existing lazy factory; push in the same `gitops:updated` tick | Watch-aligned (CLAUDE.md: never poll); one payload feeds row + panel |
| 3 | `ReconcileWithSource` degrades to a plain reconcile when the source can't be resolved | An action must never hard-fail on an unusual/managed-by-Flux source |
| 4 | Carry the `Ready` reason (not just message) end to end | The reason is the one-word router to the fix; the message is often truncated boilerplate |
| 5 | Resolve `dependsOn` states frontend-side from the loaded resource list | Zero extra reads; the data is already in the store every tick |
| 6 | Default drift surface = read Flux's telemetry (events + conditions + inventory), not a diff | Flux auto-heals drift each reconcile, so a default Git diff is empty/misleading; the controller's own record of what it corrected is the truthful, obtainable, zero-credential signal |
| 7 | A real diff is an on-demand `flux diff` shell-out, scoped to suspended / apply-failing resources | Those are the only cases a Git diff shows what telemetry cannot; user-triggered keeps SOPS/KMS/multi-cloud off the hot path |
| 8 | Shell out to the `flux` CLI rather than a native Go Git-render engine | The CLI already solves SOPS via age/GPG + AWS/Azure/GCP KMS using the shell's per-cloud auth - exactly the four-provider matrix; a native engine would re-implement all of it + bloat the binary |
| 9 | No `flux diff` for HelmReleases | No `flux diff helmrelease` exists; HR drift stays the telemetry read. `helm diff` path is a later follow-up |
| 10 | Image-automation + notification-controller stay out | Tier 2 (notification-controller no longer blocked on the alerting non-goal per the 2026-06-17 directive, but still deferred to keep M10 focused) |
