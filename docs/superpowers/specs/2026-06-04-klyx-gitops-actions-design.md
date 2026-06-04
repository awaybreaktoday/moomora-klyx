# Klyx GitOps M3-c design (operational actions + Git navigation)

Date: 2026-06-04
Status: approved design, ready for plan
Scope: M3-c. The first writes to a cluster. Flux-only operational actions
(reconcile, suspend/resume) plus Git-source navigation, surfaced on the M3-b
detail panel. Reference: mockup 2 (inline expansion). Architecture: Approach A
(on-demand imperative methods, no new informers).

## 0. Direction change (recorded)

M3-c introduces the first cluster writes. The owner chose the **control-plane
direction**: Klyx may drive controllers and perform day-2 operations, but never
*authors* desired state - Git remains the source of truth. This reframes the
CLAUDE.md non-goal from "read-only viewer for cluster state" to "no resource
authoring; operational reconciliation and day-2 ops allowed behind a guardrail."

This slice ships only the Flux verbs. The action layer is built with a clean
seam so scale/restart/delete-pod and Argo actions slot in later, but those are
NOT built now (YAGNI). The CLAUDE.md edit ships with this spec's plan.

## 1. Scope and honest boundaries

In scope (in the M3-b expanded detail panel, Flux only):
- **Reconcile**: annotate `reconcile.fluxcd.io/requestedAt: <now>` on the object
  (equivalent to `flux reconcile ks/hr <name>` without `--with-source`).
- **Suspend / Resume**: patch `spec.suspend: true|false`. Button label follows
  the current suspended state.
- **View in Git** (Kustomizations only): resolve the `GitRepository` source to a
  browsable deep link for known hosts (GitLab/GitHub), copy fallback otherwise.

Explicitly NOT in M3-c (documented as deferred):
- Argo actions and Flux/Argo coexistence (M6).
- `--with-source` reconcile (also annotating the source object).
- scale / restart / delete-pod and other day-2 ops (the seam exists; the actions
  do not).
- HelmRelease chart-source navigation (HelmRelease has no single GitRepository).
- Any resource authoring (create/edit YAML) - permanent non-goal.

## 2. Guardrail model (confirm dialog + protected tag)

Decision: every write shows a confirmation dialog; clusters tagged protected
require typing the cluster name to confirm (GitHub destructive-action pattern).

- The guardrail is **UI-enforced**. This is a single-user desktop tool; UI gating
  is the right weight. The backend stays a thin executor that (a) exposes each
  cluster's `protected` flag and (b) returns a clear error on RBAC failure.
- `ClusterConfig` gains `Environment string` (free label `dev`/`stg`/`prd`, also
  shown on the fleet card) and `Protected bool` (gates the name-typing path).
- Both flow `config -> Snapshot -> ClusterDTO` so the frontend knows, per
  cluster, the environment label and whether writes are protected.

## 3. Config layer (`internal/config`)

`ClusterConfig` gains:
```go
Environment string `yaml:"environment"` // free label: dev/stg/prd; shown on card
Protected   bool   `yaml:"protected"`   // true => confirm requires typing name
```
Both optional (zero values: empty label, unprotected). Carried through the
existing config -> resolver -> ClusterConn path. Test: load a fixture with
environment/protected set and assert they parse.

## 4. Data layer writes (`internal/fleet` + `internal/gitops/flux`)

### 4.1 Pure cores in `internal/gitops/flux` (unit-tested, exact bytes)
```go
const ReconcileRequestedAtAnnotation = "reconcile.fluxcd.io/requestedAt"
func ReconcilePatch(now time.Time) []byte // {"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":"<RFC3339Nano>"}}}
func SuspendPatch(suspend bool) []byte     // {"spec":{"suspend":true|false}}
func ResourceForKind(k Kind) (string, bool) // Kustomization->kustomizations, HelmRelease->helmreleases
```

### 4.2 `flux.Detail` gains suspended state
`ParseDetail` reads `spec.suspend` into a new `Detail.Suspended bool`. A suspended
resource is a distinct state (deliberately paused), not "not ready". Test:
fixture with `spec.suspend: true` parses `Suspended == true`.

### 4.3 `ClusterConn` imperative methods (added to `Conn` + `fakeConn`)
```go
func (c *ClusterConn) Reconcile(ctx context.Context, kind, ns, name string) error
func (c *ClusterConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error
```
Each resolves the resource via `ResourceForKind` + the existing `preferredVersion`
helper for the group/version, then:
```go
c.dyn.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
```
`Reconcile` builds the body from `c.clk.Now()` (deterministic with the fake clock).
Errors propagate verbatim - a read-only kubeconfig's 403 becomes the user-facing
message. Tests: against the dynamic fake, assert the recorded patch action +
body; a reactor-forced 403 surfaces as a non-nil error.

## 5. View-in-git resolver (`internal/gitops/flux`)

Pure function, the meaty testable unit:
```go
type GitLink struct {
    URL        string `json:"url"`
    IsDeepLink bool   `json:"isDeepLink"`
    CopyText   string `json:"copyText"`
}
func ResolveGitLink(remote, path, revision string) GitLink
```
- `remote` = `GitRepository.spec.url`; `path` = `Kustomization.spec.path`;
  `revision` = applied revision (`main@sha1:abc` -> ref `main`; split on `@`).
- Normalise SSH/scp remotes (`git@gitlab.com:org/repo.git`, `ssh://git@host/…`)
  to `https://host/org/repo`, strip a trailing `.git`.
- GitLab host -> `https://<host>/<org>/<repo>/-/tree/<ref>/<path>`.
- GitHub host -> `https://<host>/<org>/<repo>/tree/<ref>/<path>`.
- Unknown host -> `IsDeepLink:false`, `CopyText: "<remote> <path>@<revision>"`.
- Empty path -> link to the repo root at `<ref>`.

The `GitRepository` is fetched on demand in appbridge (§6), not watched. Fixture
tests: GitLab https, GitLab scp-style SSH, GitHub https, self-hosted/unknown
host, empty path.

## 6. appbridge (`GitOpsService`)

```go
type ActionResultDTO struct { OK bool `json:"ok"`; Error string `json:"error"` }
type GitLinkDTO     struct { URL string `json:"url"`; IsDeepLink bool `json:"isDeepLink"`; CopyText string `json:"copyText"` }

func (s *GitOpsService) Reconcile(cluster, kind, ns, name string) ActionResultDTO
func (s *GitOpsService) SetSuspend(cluster, kind, ns, name string, suspend bool) ActionResultDTO
func (s *GitOpsService) ResolveGitLink(cluster, kind, ns, name string) GitLinkDTO
```
- `GitOpsConn` gains `Reconcile(ctx,…) error` and `SetSuspend(ctx,…,bool) error`;
  fleet `Conn` satisfies them, the appbridge fake adds stubs.
- `Reconcile`/`SetSuspend` run with a bounded `context.WithTimeout`; any error maps
  to `ActionResultDTO{OK:false, Error: err.Error()}`, else `{OK:true}`.
- `ResolveGitLink`: load the Kustomization from the watch store (`GitOpsObject`)
  -> read `spec.sourceRef` (name; namespace defaults to the object's) -> fetch the
  `GitRepository` (group `source.toolkit.fluxcd.io`, preferred version, resource
  `gitrepositories`) via the dynamic client -> `flux.ResolveGitLink(url, path,
  revision)`. Non-GitRepository source or a HelmRelease returns a zero
  `GitLinkDTO{}` (frontend hides the link).
- Browser open is NOT done here. `ResolveGitLink` only returns the URL; the
  frontend opens it via `@wailsio/runtime` `Browser.OpenURL`, keeping the service
  free of an app handle.

Tests: fake conn returning a seeded Kustomization + GitRepository -> assert the
resolved DTO; reconcile/suspend success and a forced-error ActionResultDTO.

## 7. Frontend

The M3-b expanded detail panel gains an **actions row**:
- **Reconcile** -> confirm dialog -> `reconcile(...)` -> toast (success/error string).
- **Suspend/Resume** (label from `detail.suspended`) -> confirm dialog ->
  `setSuspend(...)` -> toast.
- **View in Git** (Kustomization with a resolvable source) -> `resolveGitLink(...)`;
  `isDeepLink` -> `Browser.OpenURL`, else copy `copyText` + toast.

**Confirm dialog** (`chrome/ConfirmDialog.tsx`): shows cluster · resource · action.
When the cluster is `protected`, renders a text input; the confirm button stays
disabled until the typed value equals the cluster name.

**Other UI:**
- **Suspended badge** on suspended rows and in the detail panel (distinct from
  "not ready").
- **Environment chip** on the fleet `ClusterCard` (`prd`/`stg`/`dev`) from the new
  config field, with a subtle protected-lock affordance.
- `bridge/gitops.ts` gains `reconcile/setSuspend/resolveGitLink`; the store holds
  transient action-status for the toast. After a successful write, the existing
  `gitops:updated` tick refreshes the row - no manual refetch.

Frontend tests (vitest): confirm-dialog gating (protected requires exact name;
non-protected one-click); an action button calling the bridge and rendering the
result toast; the suspended badge; view-in-git choosing open-vs-copy on
`isDeepLink`.

## 8. Decomposition (two plans, one spec)

- **M3-c-i — writes + guardrail:** §3 config, §4 patch cores + `Suspended` parse +
  `ClusterConn.Reconcile/SetSuspend`, §6 reconcile/suspend appbridge, §7 confirm
  dialog + actions row + suspended badge + env chip, plus the CLAUDE.md non-goal
  edit. The principle-shifting, must-be-safe half. Native-verified on
  `homelab-nelli` before the second plan.
- **M3-c-ii — view-in-git:** §5 `ResolveGitLink`, §6 `ResolveGitLink` appbridge +
  GitRepository fetch, §7 link/copy behaviour. Pure-read, independent, lower-risk.

Each plan is independently shippable and native-verifiable.

## 9. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Control-plane direction; reframe read-only to "no authoring" | Owner's call; Git stays source of truth, but operational reconciliation/day-2 ops are legitimate platform work |
| 2 | Confirm dialog always; protected clusters require typing the name | Fleet spans PRD; friction scaled to risk, GitHub destructive-action pattern |
| 3 | Guardrail UI-enforced; backend a thin executor | Single-user desktop tool; backend exposes the flag + surfaces RBAC errors |
| 4 | Approach A: on-demand methods, no new informers | Mirrors GetResourceDetail; zero standing watch cost for a rarely-clicked link |
| 5 | Pure patch-body + URL-resolver cores in flux | Risky bits (patch shape, SSH->HTTPS rewrite) become deterministically testable |
| 6 | View-in-git Kustomizations only, smart link + copy fallback | HelmRelease chart sources are ambiguous; unknown hosts degrade gracefully |
| 7 | `Suspended` is a distinct state, not "not ready" | A paused Kustomization is deliberate, not failing |
| 8 | Two plans under one spec (writes, then view-in-git) | Isolates the principle-shifting write half for native verification before the read-only navigation half |
| 9 | scale/restart/delete-pod + Argo deferred | Seam built, actions not; keeps the slice focused |
