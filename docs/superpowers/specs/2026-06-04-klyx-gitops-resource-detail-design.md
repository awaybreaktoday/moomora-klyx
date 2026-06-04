# Klyx GitOps M3-b design (resource detail + inventory)

Date: 2026-06-04
Status: approved design, ready for plan
Scope: M3-b, reframed after validating on the homelab. An inline resource-detail
drilldown for Flux resources (revisions + apply-failure flag, Ready/Healthy
conditions, managed-object inventory) - NOT a YAML diff. Builds on M3-a. Reference:
mockup 2 (inline expansion).

## 1. Context: why this is not a YAML diff

Validated read-only on `homelab-nelli`:
- Flux applies with server-side apply; `last-applied-configuration` is absent and
  `managedFields` is an ownership map, not applied values - so a field-level diff
  cannot be reconstructed read-only.
- A true live-vs-Git YAML diff requires rendering the source (Git clone +
  `kustomize build` matching Flux's postBuild substitutions) - a separate, large
  milestone, deliberately out of scope.
- What the CR DOES expose (and the M3-a gitops informers already watch):
  `status.inventory.entries` (managed objects), `status.lastAppliedRevision` vs
  `lastAttemptedRevision` (apply-failure signal when they diverge), and the
  `Ready` + `Healthy` conditions (Flux runs health checks over the inventory and
  sets `Healthy`, giving aggregate health for free).

So M3-b is a **resource-detail drilldown** from CR data: "what does this reconcile,
is it reconciled/healthy, did the last apply succeed" - achievable read-only with
no new API reads.

## 2. Scope and honest boundaries

In scope (inline expand under a GitOps row):
- Source/revision: applied revision; an "apply failed at `<attempted>`" flag when
  `lastAttemptedRevision != lastAppliedRevision`.
- Conditions: `Ready` and `Healthy` (status, reason, message).
- Inventory (Kustomization): managed objects as `kind · namespace/name` from
  `status.inventory.entries`. HelmRelease has no inventory in its CR - shows
  conditions only with a muted note.

Explicitly NOT in M3-b (documented):
- No field-level YAML diff (Git-render milestone).
- No per-inventory-object live readiness fetch (needs reading arbitrary kinds +
  a generic status engine like kstatus - a later enhancement). Aggregate health
  comes from the `Healthy` condition.
- No HelmRelease per-object inventory (not in the CR).

## 3. Data layer (no new API reads - reads the live gitops informer store)

### 3.1 `internal/gitops/flux` - pure detail parser
```go
type Condition struct { Type, Status, Reason, Message string }
type InventoryEntry struct { Group, Version, Kind, Namespace, Name string }
type Detail struct {
    Kind              Kind
    Namespace, Name   string
    AppliedRevision   string
    AttemptedRevision string
    Conditions        []Condition
    Inventory         []InventoryEntry
}
func ParseDetail(u *unstructured.Unstructured) Detail
```
`ParseDetail` reads `status.lastAppliedRevision`/`lastAttemptedRevision`, maps
every `status.conditions` entry to `Condition`, and parses
`status.inventory.entries`: each `id` is Flux's `"<namespace>_<name>_<group>_<kind>"`
(group empty for core kinds, namespace empty for cluster-scoped) plus `v`. Split
on `_` into four parts (safe: k8s names/namespaces/groups/kinds contain no
underscore). Pure, unit-tested.

### 3.2 `internal/fleet` - expose the watched object
```go
func (c *ClusterConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
```
Reads the right gitops informer store (ks informer for Kustomization, hr for
HelmRelease), returns the object by namespace/name (false if not found / watch
closed). Added to the `Conn` interface + the registry test `fakeConn` stub. A
store lookup on the already-running watch - no cluster I/O.

## 4. appbridge (on-demand bound method)

```go
type ConditionDTO struct { Type, Status, Reason, Message string } // json: type/status/reason/message
type InventoryEntryDTO struct { Group, Version, Kind, Namespace, Name string }
type ResourceDetailDTO struct {
    Kind, Namespace, Name              string
    AppliedRevision, AttemptedRevision string
    ApplyFailed                        bool
    Conditions                         []ConditionDTO
    Inventory                          []InventoryEntryDTO
}
func toDetailDTO(d flux.Detail) ResourceDetailDTO   // computes ApplyFailed
```
- `GitOpsConn` (appbridge) gains `GitOpsObject(kind, namespace, name)
  (*unstructured.Unstructured, bool)` - fleet `Conn` already satisfies it (3.2);
  the appbridge fake adds it.
- `GitOpsService.GetResourceDetail(cluster, kind, namespace, name) ResourceDetailDTO`
  (bound to JS): lookup conn -> `GitOpsObject` -> `flux.ParseDetail` -> `toDetailDTO`.
  Zero-value DTO when the object isn't in the store. `ApplyFailed = AttemptedRevision
  != "" && AttemptedRevision != AppliedRevision`.

Request/response (not pushed). Called on expand and re-called on each
`gitops:updated` tick for liveness - a cheap store read, no per-call API hit.

## 5. Frontend (inline expandable rows)

- Store gitops slice gains `expandedKey: string | null` (`"<kind>/<ns>/<name>"`),
  `detail: ResourceDetailDTO | null`, with `expand(ref)/collapse()/setDetail(d)`.
- `bridge/gitops.ts`: `getResourceDetail(cluster, kind, ns, name)` -> bound
  `GitOpsService.GetResourceDetail` -> `setDetail`.
- `GitOps.tsx`: rows clickable (chevron affordance); click toggles expand. On
  expand fetch detail; a `useEffect` keyed on `[expandedKey, gitops.resources]`
  re-fetches on each list tick so the open panel stays live. The expanded panel
  (indented under the row) shows: source (applied revision; danger "apply failed
  at `<attempted>`" when `applyFailed`), `Ready` + `Healthy` condition rows
  (status dot + reason + message), and the inventory (`kind · namespace/name`) for
  Kustomizations; HelmReleases show conditions + a muted "no inventory in the
  HelmRelease CR" note.
- Visual language unchanged (tokens, mono identifiers, status colours).

## 6. Testing

- **flux `ParseDetail`:** fixtures from the probe shape - conditions (Ready+Healthy),
  applied/attempted revisions, inventory incl. a cluster-scoped (empty namespace)
  and an empty-group (core kind) entry; a HelmRelease fixture (no inventory).
- **fleet `GitOpsObject`:** seed the dynamic fake -> assert the store lookup returns
  the object by ns/name (extends the gitops-watch test).
- **appbridge `toDetailDTO` + `GetResourceDetail`:** fake conn returning a fixture
  unstructured -> assert the DTO incl. `ApplyFailed` true and false.
- **frontend:** mock `getResourceDetail`; expand a Kustomization row -> assert
  revisions, Ready/Healthy conditions, an inventory entry render; an `applyFailed`
  row shows the danger line; a HelmRelease row shows the no-inventory note.
- **Playwright smoke + native handoff:** expand `flux-system` -> inventory +
  conditions; native confirmation is the user's.

## 7. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Reframe M3-b from YAML diff to resource-detail drilldown | Validated: no field diff obtainable read-only; SSA managedFields = ownership not values |
| 2 | Detail from the live gitops informer store, no new reads | Watch-aligned; the CR already carries inventory/conditions/revisions |
| 3 | Aggregate health via the Healthy condition; no per-object fetch | Flux already health-checks the inventory; per-object kstatus is a later enhancement |
| 4 | Apply-failure = attempted != applied | The reliable failure signal from the probe |
| 5 | On-demand GetResourceDetail (not pushed) | Detail is viewed for one row at a time; request/response keeps payloads small |
| 6 | YAML diff + per-object readiness deferred | Git-render / kstatus are separate larger investments |
