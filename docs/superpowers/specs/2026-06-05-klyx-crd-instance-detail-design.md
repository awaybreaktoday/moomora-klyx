# Klyx M4-c design (CRD instance detail / YAML)

Date: 2026-06-05
Status: approved design, ready for plan
Scope: M4-c, the third and final plan under the M4 spec
(`docs/superpowers/specs/2026-06-05-klyx-crd-browser-design.md`). A full-page
per-instance detail reached by clicking a row in the M4-b instance list:
header + generic conditions strip + describe-style Events + full object YAML.
One dynamic Get + one Events list. Snapshot, no watch.

## 1. Scope, navigation, content

Clicking an instance row in the M4-b list opens a **full-page detail**. The
cluster route gains an optional `instance` ref `{namespace, name}` alongside the
existing `resource`; when both are set the Resources section renders
`InstanceDetail`. Breadcrumb: `… / <cluster> / Resources / <Kind> / <name>`,
where the `<Kind>` crumb returns to the list and `Resources` returns to the
browser.

The page shows, top to bottom:
- **Header**: kind, namespace/name, age, labels.
- **Conditions**: a generic `status.conditions` strip (type / status / reason /
  message). Conditions is a near-universal Kubernetes convention; hidden when
  absent.
- **Events**: describe-style, newest first, Warning events highlighted (last ~50,
  filtered to this object via `involvedObject.uid`).
- **YAML**: the full object, read-only, monospace, with a **copy** button.

A **refresh** button re-fetches (snapshot on open, no watch). Plain monospace
YAML - no syntax highlighting in v1. The YAML is raw like `kubectl get -o yaml`
(no redaction; read-only access to what is already in etcd).

In scope: the full-page detail, header, conditions strip, Events panel, YAML +
copy + refresh, route-carried instance selection, breadcrumb/back, cluster-vs-
namespaced handling.

Out of scope (deferred / non-goals): editing YAML (CLAUDE.md non-goal -
read-only), syntax highlighting, live watch of the object, per-kind structured
"spec highlights" (no universal shape across arbitrary CRDs - the YAML carries
the rest).

## 2. Data layer (`internal/crd` + `internal/fleet`)

### 2.1 Pure pieces (`internal/crd`)
```go
type Condition struct { Type, Status, Reason, Message string }
type Event struct {
    Type    string // Normal | Warning
    Reason  string
    Message string
    Count   int32
    Last    time.Time
}
type InstanceDetail struct {
    Kind, Namespace, Name string
    Created               time.Time
    Labels                map[string]string
    Conditions            []Condition
    Events                []Event
    YAML                  string
}
func ParseConditions(obj map[string]interface{}) []Condition // status.conditions[]
func ToYAML(obj map[string]interface{}) (string, error)       // sigs.k8s.io/yaml
```
`ParseConditions` maps each `status.conditions[]` entry (type/status/reason/
message) - pure, unit-tested. `ToYAML` marshals the unstructured `Object` map via
`sigs.k8s.io/yaml` (promote it from an indirect to a direct dependency).

### 2.2 `ClusterConn.GetInstanceDetail`
```go
func (c *ClusterConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error)
```
1. Dynamic `Get` the one object: `c.dyn.Resource(gvr).Namespace(ns).Get(...)` for
   namespaced, `c.dyn.Resource(gvr).Get(...)` for cluster-scoped (`ns == ""`).
2. `crd.ToYAML(u.Object)` + `crd.ParseConditions(u.Object)` + header fields
   (`u.GetKind()`, `u.GetCreationTimestamp().Time`, `u.GetLabels()`); capture
   `u.GetUID()`.
3. List core Events: `c.typed.CoreV1().Events("").List(ctx, metav1.ListOptions{
   FieldSelector: "involvedObject.uid=<uid>", Limit: 50})`, map each to
   `crd.Event` (`Type`/`Reason`/`Message`/`Count`/`LastTimestamp` or `EventTime`),
   sort newest-first by `Last`. An Events-list error degrades to empty events -
   the detail still returns with YAML/conditions.

Added to the fleet `Conn` interface + the `fakeConn` stub. Returns the parsed
`InstanceDetail`; the dynamic-Get error propagates (the detail can't render
without the object).

## 3. appbridge (`CRDService.GetInstanceDetail`)

Reuses the existing `ConditionDTO` (from the GitOps detail). New `EventDTO` and
`InstanceDetailDTO`:
```go
type EventDTO struct {
    Type     string `json:"type"`     // Normal | Warning
    Reason   string `json:"reason"`
    Message  string `json:"message"`
    Count    int    `json:"count"`
    LastSeen string `json:"lastSeen"` // RFC3339; "" when unset
}
type InstanceDetailDTO struct {
    Kind       string            `json:"kind"`
    Namespace  string            `json:"namespace"`
    Name       string            `json:"name"`
    Created    string            `json:"created"` // RFC3339; "" when unset
    Labels     map[string]string `json:"labels"`
    Conditions []ConditionDTO    `json:"conditions"`
    Events     []EventDTO        `json:"events"`
    YAML       string            `json:"yaml"`
}
func (s *CRDService) GetInstanceDetail(cluster, group, version, plural, namespace, name string) InstanceDetailDTO
```
Looks up the conn, calls `conn.GetInstanceDetail` under a bounded context, maps
`crd.InstanceDetail` -> DTO (`Created`/`LastSeen` via `Format(time.RFC3339)`, zero
time -> `""`; conditions/events mapped; `Labels` defaulted to an empty map when
nil for stable JSON). Zero-value DTO (`InstanceDetailDTO{}`) on a cluster miss or
error. `CRDConn` gains `GetInstanceDetail`; the appbridge fake stubs it. Age is
formatted client-side from the RFC3339 timestamps (keeps `CRDService`
clock-free). Tested with a fake conn.

## 4. Route + store (`store/fleet.ts`, frontend-only)

### 4.1 Route
The cluster variant gains `instance?: InstanceRef`:
```ts
type InstanceRef = { namespace: string; name: string };
type Route = { name: "fleet" } | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef; instance?: InstanceRef };
```
`InstanceDetail` renders when `route.resource && route.instance`.

Actions:
- `openInstance(namespace, name)` -> sets `route.instance` (keeps cluster/section/
  resource) and flags the detail loading.
- `closeInstance()` -> clears `route.instance` (back to the list).
- `openResource` also clears `instance`; `closeResource` clears both `resource`
  and `instance`; `setSection` already drops `resource` and now also drops
  `instance`.

### 4.2 Instance-detail slice (separate, focused)
```ts
type InstanceDetailSlice = { ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean };
```
Actions: `setInstanceDetailLoading(ref)` (sets ref + loading, clears detail),
`setInstanceDetail(d)` (sets detail, clears loading), `clearInstanceDetail()`.
The `ref` copy lets the view drop a stale detail that resolves after navigation -
the same guard pattern as the `instances` slice.

## 5. Frontend (`InstanceDetail` + wiring)

### 5.1 Bridge
`bridge/crd.ts` gains:
```ts
getInstanceDetail(cluster, resourceRef, instanceRef) // setInstanceDetailLoading -> CRDService.GetInstanceDetail(cluster, resourceRef.group, resourceRef.version, resourceRef.plural, instanceRef.namespace, instanceRef.name) -> ref-guard -> setInstanceDetail
```
The ref guard re-checks `instanceDetail.ref` after the await (drops a detail for a
superseded instance).

### 5.2 `InstanceDetail.tsx` (Resources section when `route.instance` is set)
- **Header**: kind + namespace/name (mono) + age + labels row; a **refresh**
  button (re-calls `getInstanceDetail`).
- **Conditions**: status dot (True=green / False=red / else grey) + type +
  reason/message, reusing the M3-b condition rendering; hidden when none.
- **Events**: rows of `type · reason · message · ×count · age`; Warning rows
  tinted danger; a muted "no events" note when empty.
- **YAML**: a monospace `<pre>` of `detail.yaml` with a **copy** button
  (`@wailsio/runtime` `Clipboard.SetText`, reusing the action-status toast).
- Loading state on first fetch; on mount / `instance` change: fetch; cleanup
  `clearInstanceDetail`; the `ref` guard drops a stale detail.

### 5.3 Wiring
- `InstanceList` rows become clickable -> `openInstance(r.namespace, r.name)`.
- `ClusterDetail`: `resources` section -> `route.instance ? <InstanceDetail/> :
  route.resource ? <InstanceList/> : <CRDBrowser/>`.
- `Breadcrumb`: when `route.instance` is set, append a `<name>` crumb after the
  kind; the kind crumb becomes a back button (`closeInstance`).

### 5.4 Frontend tests (vitest)
Store actions (openInstance/closeInstance, setInstanceDetailLoading/
setInstanceDetail/clearInstanceDetail, and that openResource/closeResource/
setSection drop `instance`); `InstanceDetail` renders header/conditions/events/
YAML from a mocked bridge, the copy button calls the runtime, Warning event
tinting, the empty-events note, refresh re-calls the bridge; `InstanceList` row
click calls `openInstance`; `Breadcrumb` shows the name crumb and the kind crumb
returns to the list.

## 6. Testing summary

- **`internal/crd`**: `ParseConditions` (fixture with two conditions);
  `ToYAML` (round-trips an unstructured to a YAML string containing kind/name).
- **`internal/fleet`**: `GetInstanceDetail` against the dynamic fake (object ->
  YAML + conditions + header + uid) and the typed fake (a seeded `Event` for the
  object -> mapped + newest-first); the cluster-scoped path (`ns == ""`, no
  `.Namespace`). Note: the typed fake does not enforce the `involvedObject.uid`
  field selector, so the test seeds only the matching event and asserts mapping/
  sort; the field-selector string is a passthrough.
- **appbridge**: `GetInstanceDetail` DTO mapping (`Created`/`LastSeen` RFC3339,
  zero -> "", conditions/events, nil labels -> empty map) via a fake conn.
- **frontend**: the slice + view + wiring tests in 5.4.
- **Native handoff**: on `homelab-nelli`, drill `cert-manager.io / Certificate`
  (or an `Order`) -> header/conditions/events/YAML render, copy works, refresh
  re-fetches, breadcrumb/back navigate; a cluster-scoped kind (`CiliumNode`)
  detail renders without a namespace.

## 7. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Full-page drill, route-carried `instance` ref | Room for long YAML; consistent with the M4-b list drill; breadcrumb stays route-driven |
| 2 | Header + conditions + Events + YAML | Conditions is the universal status convention; Events answer "why did it fail"; YAML carries everything else. "spec highlights" have no universal shape, so the YAML is the honest generic answer |
| 3 | One bound `GetInstanceDetail` (Get + Events) | One round-trip; the page shows it all at once; mirrors the rest of M4's request/response |
| 4 | Events filtered by `involvedObject.uid`, last 50 | uid is the precise key (no name collisions; works cluster-scoped); bounded list; newest-first |
| 5 | Events-list error degrades to empty events | A missing/expired Events API must not blank the YAML/conditions |
| 6 | Snapshot + refresh, no watch | A detail view glanced at; consistent with the M4 no-watch philosophy |
| 7 | Read-only YAML, no edit, no redaction | CLAUDE.md non-goal (no authoring); same exposure as `kubectl get -o yaml` |
