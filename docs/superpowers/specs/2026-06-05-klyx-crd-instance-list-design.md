# Klyx M4-b design (CRD instance list)

Date: 2026-06-05
Status: approved design, ready for plan
Scope: M4-b, the second plan under the M4 spec
(`docs/superpowers/specs/2026-06-05-klyx-crd-browser-design.md`). A per-kind
instance list reached by drilling into a kind from the M4-a CRD browser:
metadata-only, paginated (load-more), name/namespace/age. NO status column
(deferred to M4-c). Builds directly on M4-a's metadata-list layer.

## 1. Scope, navigation, the no-status constraint

Clicking a kind row in the CRD browser opens a **dedicated instance-list page**
for that kind. The cluster route gains an optional `resource` ref
`{group, version, plural, kind, scope}`; when set, the Resources section renders
`InstanceList` instead of `CRDBrowser`, and the breadcrumb shows
`… / <cluster> / Resources / <Kind>` with the `Resources` crumb acting as back.

The list is **metadata-only**: each row shows **namespace** (omitted for
cluster-scoped kinds), **name**, **age**. There is no status/health column - a
Kubernetes metadata list strips `spec`/`status`, and a generic "ready" across
arbitrary CRDs has no universal shape. Per-instance status/YAML is M4-c (a single
cheap GET on the one instance opened). Pagination is **load-more**: `Limit=100`
metadata pages accumulated via continue tokens, so high-cardinality kinds
(Cilium) page through and never bulk-load - consistent with the M4 no-watch,
no-bulk-objects philosophy. A client-side filter narrows the loaded rows by
name/namespace substring.

In scope (M4-b): the drill-in page, paginated metadata rows, client-side filter,
load-more, cluster-vs-namespaced column handling, breadcrumb/back.

Out of scope (deferred): per-instance status/health (no universal shape), the
instance YAML/detail view (M4-c), server-side label-selector filtering, sort
controls beyond the default namespace-then-name.

## 2. Data layer (`internal/crd` + `internal/fleet`)

### 2.1 Pure row type (`internal/crd`)
```go
type InstanceMeta struct {
    Namespace string
    Name      string
    Created   time.Time
}
```

### 2.2 Paginated metadata list (`internal/fleet`)
```go
func (c *ClusterConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error)
```
Builds `gvr = {group, version, plural}` and lists via the `meta` client
`ClusterConn` already holds:
```go
list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: limit, Continue: continueToken})
```
Maps each `PartialObjectMetadata` to `InstanceMeta`
(`GetNamespace()`/`GetName()`/`GetCreationTimestamp().Time`), and returns the
items plus `list.GetContinue()` as the next token (`""` on the last page). No
watch - one list page per call. Added to the fleet `Conn` interface + the
`fakeConn` stub. Tested against the metadata fake (the M4-a verified seeding
pattern) for the happy path (items mapped, empty next token); pagination via the
continue token is a passthrough the fake cannot drive, so token plumbing is
covered at the appbridge/frontend layer.

## 3. appbridge (`CRDService.ListInstances`)

Request/response, no clock dependency (age is formatted client-side from the
timestamp):
```go
type InstanceDTO struct {
    Namespace string `json:"namespace"`
    Name      string `json:"name"`
    Created   string `json:"created"` // RFC3339; "" when unset
}
type InstancePageDTO struct {
    Items     []InstanceDTO `json:"items"`
    NextToken string        `json:"nextToken"`
}

const instancePageSize = 100
func (s *CRDService) ListInstances(cluster, group, version, plural, continueToken string) InstancePageDTO
```
Looks up the conn, calls `conn.ListInstances(ctx, group, version, plural,
instancePageSize, continueToken)` under a bounded context, maps `InstanceMeta` ->
`InstanceDTO` (`Created = m.Created.Format(time.RFC3339)`, zero time -> `""`), and
returns the items plus the next token. Empty page
(`InstancePageDTO{Items: []InstanceDTO{}}`) on a cluster miss or error. The
`CRDConn` interface gains `ListInstances`; the fleet `Conn` satisfies it and the
appbridge fake stubs it. Tested with a fake conn (mapping + token passthrough,
zero-time -> "").

## 4. Route + store (`store/fleet.ts`, frontend-only)

### 4.1 Route
The cluster route variant gains an optional `resource`:
```ts
type ResourceRef = { group: string; version: string; plural: string; kind: string; scope: string };
type Route = { name: "fleet" } | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef };
```
Actions:
- `openResource(ref)` -> sets route to `{name:"cluster", cluster, section:"resources", resource:ref}` (cluster from the current route) and clears prior instance rows.
- `closeResource()` -> clears `route.resource` (back to the browser), keeping the cluster + `resources` section.

### 4.2 Instances slice (separate from `crd`)
```ts
type InstancesSlice = { ref: ResourceRef | null; rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string };
```
Actions: `setInstancesLoading(ref)` (sets ref + loading, resets rows/token/filter),
`addInstancePage(items, nextToken)` (appends rows, sets token, clears loading),
`setInstanceFilter(s)`, `clearInstances()`. The `ref` copy lets the view confirm
rows belong to the current selection and drop a stale async page that lands after
navigation - the same guard pattern as `gitops.cluster`/`crd.cluster`.

## 5. Frontend (`InstanceList` + wiring)

### 5.1 Bridge
`bridge/crd.ts` gains:
```ts
loadInstances(cluster, ref, token?) // CRDService.ListInstances(cluster, ref.group, ref.version, ref.plural, token ?? "") -> addInstancePage
```
First load (no token) is preceded by `setInstancesLoading(ref)`.

### 5.2 `InstanceList.tsx` (rendered for the Resources section when `route.resource` is set)
- Header: `<Kind>` + scope badge; a filter input (`name, namespace…`).
- Columns: namespace (only for namespaced kinds), name (mono), age (formatted
  from `created` via an `age()` helper; "" timestamp -> "").
- Rows filtered client-side by name/namespace substring; sorted
  namespace-then-name.
- **Load more** button when `nextToken` is non-empty ->
  `loadInstances(cluster, ref, nextToken)`; a `N loaded` count beside it.
- Loading state on the first page; empty state ("No instances") when the first
  page returns nothing.
- On mount / `ref` change: `clearInstances()` then load the first page; the
  `instances.ref` guard drops pages from a superseded selection.

### 5.3 Wiring
- `CRDBrowser` kind rows become clickable -> `openResource({group, version,
  plural, kind, scope})` (built from the kind's `FlatKind`).
- `ClusterDetail`: `resources` section -> `route.resource ? <InstanceList/> :
  <CRDBrowser/>`.
- `Breadcrumb`: when `route.resource` is set, append a `<Kind>` crumb; the
  `Resources` crumb calls `closeResource()`.

### 5.4 Frontend tests (vitest)
Store route/instance actions (openResource/closeResource, setInstancesLoading/
addInstancePage/setInstanceFilter/clearInstances); `InstanceList` renders rows
from a mocked bridge, shows Load-more only when `nextToken` set and calls the
bridge with the token, filters rows, empty state, omits the namespace column for
a cluster-scoped kind; `CRDBrowser` kind-click calls `openResource`; `Breadcrumb`
shows the kind crumb and back clears it.

## 6. Testing summary

- **`internal/fleet`**: `ListInstances` against the metadata fake -> namespace/
  name/created mapped, empty next token.
- **appbridge**: `ListInstances` DTO mapping (`created` RFC3339, zero -> "") +
  `nextToken` passthrough via a fake conn.
- **frontend**: the slice + view + wiring tests in 5.4.
- **Native handoff**: on `homelab-nelli`, drill into `CiliumEndpoint` -> rows
  paginate with Load-more; filter works; breadcrumb/back navigate cleanly; a
  cluster-scoped kind (`CiliumNode`) shows no namespace column.

## 7. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Metadata-only paginated list, no status column | Metadata lists strip spec/status; generic CRD status has no universal shape; scales to Cilium by construction |
| 2 | Dedicated drill-in page, route-carried `resource` ref | Drill state lives in the route so the breadcrumb stays pure/route-driven and back is just clearing `resource` |
| 3 | Load-more pagination (Limit=100 + continue token) | Simplest pagination that pages through high-cardinality kinds without bulk-loading; virtualized infinite scroll deferred |
| 4 | Age formatted client-side from RFC3339 `created` | Keeps `CRDService` clock-free; the frontend already formats relative times |
| 5 | Separate `instances` store slice with a `ref` guard | Focused state; the ref copy drops stale async pages after navigation |
| 6 | Per-instance status/YAML deferred to M4-c | A single-object GET on one opened instance is cheap and has the full object; bulk status does not |
