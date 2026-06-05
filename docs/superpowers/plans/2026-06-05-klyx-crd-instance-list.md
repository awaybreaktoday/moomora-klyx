# M4-b: CRD Instance List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drill into a kind from the CRD browser to a dedicated, paginated, metadata-only instance list (name/namespace/age, no status), reached via a route-carried resource ref with a working breadcrumb/back.

**Architecture:** Reuses M4-a's metadata client. `ClusterConn.ListInstances` does a single `Limit=100` metadata-only list page + continue token; `CRDService.ListInstances` shapes a page DTO; the cluster route gains an optional `resource` ref so the breadcrumb stays route-driven; a React `InstanceList` renders rows with load-more pagination. No watch, no bulk objects (scales to Cilium).

**Tech Stack:** Go 1.26 + client-go v0.36 (metadata fake), Wails v3 bound services, React 19 + TS 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **Metadata-only:** `ClusterConn` already holds `meta metadata.Interface` (used by M4-a's `CountResource`). `c.meta.Resource(gvr).List(ctx, opts)` returns `*metav1.PartialObjectMetadataList` (name/namespace/creationTimestamp/labels - NO spec/status). That is why the list has no status column.
- **Pagination:** `ListOptions{Limit, Continue}`; `list.GetContinue()` is the next token (`""` on the last page).
- **Metadata fake (verified, reuse):** `internal/fleet/crd_test.go` already has `partialMeta(group, version, kind, ns, name)` and the `metadatafake.NewSimpleMetadataClient` + `metav1.AddMetaToScheme` pattern. The fake does NOT paginate (it ignores Limit/Continue), so the capped/continue path is covered at the appbridge/frontend layer, not the fake.
- **Route today** (`store/fleet.ts:60-62`): `{ name: "cluster"; cluster; section }`. This plan adds an optional `resource?: ResourceRef`. `setSection` currently spreads `...s.route` (line 124) - it MUST be changed to drop `resource` when changing section.
- **Wire points:** `ClusterDetail.tsx:25` renders `<CRDBrowser>` for `resources`; the CRDBrowser kind row is `CRDBrowser.tsx:148`; the breadcrumb section span is `Breadcrumb.tsx:23-28`.
- **Request/response:** `CRDService` has no push loop; `ListInstances` is a bound method like `ListCRDs`/`CountKind`. Age is formatted client-side from the RFC3339 `created` (keeps `CRDService` clock-free).

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/crd/crd.go` | `InstanceMeta` type | Modify |
| `internal/fleet/crd.go` | `ClusterConn.ListInstances` | Modify |
| `internal/fleet/crd_test.go` | metadata-fake list test | Modify |
| `internal/fleet/conn.go` | `Conn` interface += ListInstances | Modify |
| `internal/fleet/registry_test.go` | `fakeConn` stub | Modify |
| `internal/appbridge/crd_dto.go` | `InstanceDTO` + `InstancePageDTO` | Modify |
| `internal/appbridge/crd_service.go` | `CRDConn` += ListInstances; `CRDService.ListInstances` | Modify |
| `internal/appbridge/crd_service_test.go` | fake stub + mapping test | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | Route.resource, openResource/closeResource, instances slice | Modify |
| `cmd/klyx/frontend/src/store/fleet.test.ts` | store action tests | Modify |
| `cmd/klyx/frontend/src/bridge/crd.ts` | `loadInstances` | Modify |
| `cmd/klyx/frontend/src/cluster/InstanceList.tsx` | the view | Create |
| `cmd/klyx/frontend/src/cluster/InstanceList.test.tsx` | view tests | Create |
| `cmd/klyx/frontend/src/cluster/CRDBrowser.tsx` | kind row -> openResource | Modify |
| `cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx` | kind-click test | Modify |
| `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx` | resources -> InstanceList when resource set | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` | kind crumb + back | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx` | crumb test (append `it`) | Modify |

---

## Task 1: Go data layer - `ClusterConn.ListInstances`

**Files:**
- Modify: `internal/crd/crd.go` (add `InstanceMeta`)
- Modify: `internal/fleet/crd.go` (add `ListInstances`)
- Test: `internal/fleet/crd_test.go`
- Modify: `internal/fleet/conn.go` (`Conn` interface), `internal/fleet/registry_test.go` (`fakeConn`)

- [ ] **Step 1: Write the failing test**

Add to `internal/fleet/crd_test.go` (reuses the existing `partialMeta` helper + `metadatafake` import in that file):

```go
func TestListInstances(t *testing.T) {
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	mc := metadatafake.NewSimpleMetadataClient(scheme,
		partialMeta("example.com", "v1", "Widget", "team-a", "w1"),
		partialMeta("example.com", "v1", "Widget", "team-b", "w2"),
	)
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{})

	items, next, err := c.ListInstances(context.Background(), "example.com", "v1", "widgets", 100, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 instances, got %d", len(items))
	}
	byName := map[string]crd.InstanceMeta{}
	for _, m := range items {
		byName[m.Name] = m
	}
	if byName["w1"].Namespace != "team-a" {
		t.Fatalf("w1 namespace: %q", byName["w1"].Namespace)
	}
	if next != "" {
		t.Fatalf("fake should report no continue token, got %q", next)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestListInstances -v`
Expected: FAIL - `c.ListInstances undefined` and `crd.InstanceMeta undefined`.

- [ ] **Step 3: Add `InstanceMeta` to `internal/crd/crd.go`**

Add the import `"time"` if not present, and the type (near `Info`):

```go
// InstanceMeta is the metadata-only view of one custom-resource instance.
type InstanceMeta struct {
	Namespace string
	Name      string
	Created   time.Time
}
```

- [ ] **Step 4: Add `ListInstances` to `internal/fleet/crd.go`**

```go
// ListInstances returns one metadata-only page of instances of a kind plus the
// next continue token ("" on the last page). A single list page; no watch.
func (c *ClusterConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: limit, Continue: continueToken})
	if err != nil {
		return nil, "", err
	}
	out := make([]crd.InstanceMeta, 0, len(list.Items))
	for i := range list.Items {
		m := &list.Items[i]
		out = append(out, crd.InstanceMeta{
			Namespace: m.GetNamespace(),
			Name:      m.GetName(),
			Created:   m.GetCreationTimestamp().Time,
		})
	}
	return out, list.GetContinue(), nil
}
```

(`schema` and `metav1` are already imported in `internal/fleet/crd.go` from M4-a.)

- [ ] **Step 5: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add to the `Conn` interface (after `CountResource`):

```go
	ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error)
```

- [ ] **Step 6: Add the `fakeConn` stub**

In `internal/fleet/registry_test.go`, after the `CountResource` stub:

```go
func (f *fakeConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	return nil, "", nil
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestListInstances|Registry' -v` then `go test ./internal/fleet/ ./internal/crd/` and `go vet ./internal/fleet/`.
Expected: PASS, vet clean.

- [ ] **Step 8: Commit**

```bash
git add internal/crd/crd.go internal/fleet/crd.go internal/fleet/crd_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.ListInstances - paginated metadata-only instances"
```

---

## Task 2: appbridge - `CRDService.ListInstances`

**Files:**
- Modify: `internal/appbridge/crd_dto.go` (DTOs)
- Modify: `internal/appbridge/crd_service.go` (`CRDConn` + method)
- Test: `internal/appbridge/crd_service_test.go`

- [ ] **Step 1: Write the failing test**

In `internal/appbridge/crd_service_test.go`:

(a) Add a field to `fakeCRDConn`:
```go
	instances []crd.InstanceMeta
	nextToken string
```
(b) Add the stub method:
```go
func (f *fakeCRDConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	return f.instances, f.nextToken, nil
}
```
(c) Add the test (the `time` import is needed):
```go
func TestListInstancesMapsDTO(t *testing.T) {
	created := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	conn := &fakeCRDConn{
		instances: []crd.InstanceMeta{
			{Namespace: "team-a", Name: "w1", Created: created},
			{Namespace: "", Name: "cluster-scoped", Created: time.Time{}},
		},
		nextToken: "tok-2",
	}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	page := svc.ListInstances("x", "example.com", "v1", "widgets", "")
	if page.NextToken != "tok-2" {
		t.Fatalf("nextToken: %q", page.NextToken)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items: %d", len(page.Items))
	}
	if page.Items[0].Created != "2026-06-01T09:00:00Z" {
		t.Fatalf("created RFC3339: %q", page.Items[0].Created)
	}
	if page.Items[1].Created != "" {
		t.Fatalf("zero time must map to empty string, got %q", page.Items[1].Created)
	}
}

func TestListInstancesUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if p := svc.ListInstances("ghost", "g", "v", "p", ""); len(p.Items) != 0 || p.NextToken != "" {
		t.Fatalf("want empty page, got %+v", p)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestListInstances -v`
Expected: FAIL - `svc.ListInstances` undefined; `fakeCRDConn` no longer satisfies `CRDConn` once the interface is widened.

- [ ] **Step 3: Add DTOs to `internal/appbridge/crd_dto.go`**

```go
// InstanceDTO is the metadata-only view of one instance.
type InstanceDTO struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Created   string `json:"created"` // RFC3339; "" when unset
}

// InstancePageDTO is one page of instances plus the next continue token.
type InstancePageDTO struct {
	Items     []InstanceDTO `json:"items"`
	NextToken string        `json:"nextToken"`
}
```

- [ ] **Step 4: Extend `CRDConn` + add the method**

In `internal/appbridge/crd_service.go`, add to the `CRDConn` interface (after `CountResource`):

```go
	ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error)
```

Add the page-size const near `crdTimeout` and the bound method (`time` is already imported):

```go
const instancePageSize = 100

// ListInstances returns one page of instances of a kind plus the next token.
// Empty page on a cluster miss or error.
func (s *CRDService) ListInstances(cluster, group, version, plural, continueToken string) InstancePageDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return InstancePageDTO{Items: []InstanceDTO{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	items, next, err := conn.ListInstances(ctx, group, version, plural, instancePageSize, continueToken)
	if err != nil {
		return InstancePageDTO{Items: []InstanceDTO{}}
	}
	dtos := make([]InstanceDTO, 0, len(items))
	for _, m := range items {
		created := ""
		if !m.Created.IsZero() {
			created = m.Created.Format(time.RFC3339)
		}
		dtos = append(dtos, InstanceDTO{Namespace: m.Namespace, Name: m.Name, Created: created})
	}
	return InstancePageDTO{Items: dtos, NextToken: next}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -run TestListInstances -v` then `go test ./internal/appbridge/` and `go vet ./internal/appbridge/`.
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/crd_dto.go internal/appbridge/crd_service.go internal/appbridge/crd_service_test.go
git commit -m "feat(appbridge): CRDService.ListInstances - paged InstanceDTO"
```

---

## Task 3: Store - route resource + instances slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Test: `cmd/klyx/frontend/src/store/fleet.test.ts`
- Modify: `cmd/klyx/frontend/src/bridge/crd.ts`

- [ ] **Step 1: Write the failing store test**

Add to `cmd/klyx/frontend/src/store/fleet.test.ts`:

```ts
import { useFleet as uf2 } from "./fleet";

test("resource drill-in route + instances slice", () => {
  uf2.getState().openCluster("x");
  const ref = { group: "cilium.io", version: "v2", plural: "ciliumendpoints", kind: "CiliumEndpoint", scope: "Namespaced" };
  uf2.getState().openResource(ref);
  const r = uf2.getState().route;
  expect(r).toMatchObject({ name: "cluster", cluster: "x", section: "resources", resource: { kind: "CiliumEndpoint" } });
  expect(uf2.getState().instances.ref?.kind).toBe("CiliumEndpoint");
  expect(uf2.getState().instances.loading).toBe(true);

  uf2.getState().addInstancePage([{ namespace: "n", name: "a", created: "" }], "tok");
  expect(uf2.getState().instances.rows.length).toBe(1);
  expect(uf2.getState().instances.nextToken).toBe("tok");
  uf2.getState().addInstancePage([{ namespace: "n", name: "b", created: "" }], "");
  expect(uf2.getState().instances.rows.length).toBe(2);

  uf2.getState().setInstanceFilter("a");
  expect(uf2.getState().instances.filter).toBe("a");

  // setSection clears the resource selection.
  uf2.getState().setSection("gitops");
  const r2 = uf2.getState().route;
  expect(r2.name === "cluster" && r2.resource).toBeUndefined();

  uf2.getState().openResource(ref);
  uf2.getState().closeResource();
  const r3 = uf2.getState().route;
  expect(r3).toMatchObject({ name: "cluster", cluster: "x", section: "resources" });
  expect(r3.name === "cluster" && r3.resource).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "resource drill-in"`
Expected: FAIL - `openResource is not a function`.

- [ ] **Step 3: Implement in `src/store/fleet.ts`**

(a) Add types (near the Route type):

```ts
export type ResourceRef = { group: string; version: string; plural: string; kind: string; scope: string };
export type InstanceDTO = { namespace: string; name: string; created: string };
export type InstancesSlice = { ref: ResourceRef | null; rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string };
```

(b) Extend the `Route` cluster variant with an optional `resource`:

```ts
export type Route =
  | { name: "fleet" }
  | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef };
```

(c) Add to the `FleetState` type:

```ts
  openResource: (ref: ResourceRef) => void;
  closeResource: () => void;
  instances: InstancesSlice;
  setInstancesLoading: (ref: ResourceRef) => void;
  addInstancePage: (items: InstanceDTO[], nextToken: string) => void;
  setInstanceFilter: (s: string) => void;
  clearInstances: () => void;
```

(d) Change `setSection` to DROP `resource` when switching section (currently `{ route: { ...s.route, section } }`):

```ts
  setSection: (section) =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section } } : {})),
```

(e) Add to the store body:

```ts
  openResource: (resource) =>
    set((s) =>
      s.route.name === "cluster"
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "resources", resource },
            instances: { ref: resource, rows: [], nextToken: "", loading: true, filter: "" },
          }
        : {}),
  closeResource: () =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section: "resources" } } : {})),
  instances: { ref: null, rows: [], nextToken: "", loading: false, filter: "" },
  setInstancesLoading: (ref) => set({ instances: { ref, rows: [], nextToken: "", loading: true, filter: "" } }),
  addInstancePage: (items, nextToken) => set((s) => ({ instances: { ...s.instances, rows: [...s.instances.rows, ...items], nextToken, loading: false } })),
  setInstanceFilter: (filter) => set((s) => ({ instances: { ...s.instances, filter } })),
  clearInstances: () => set({ instances: { ref: null, rows: [], nextToken: "", loading: false, filter: "" } }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts`
Expected: all PASS.

- [ ] **Step 5: Add `loadInstances` to `src/bridge/crd.ts`**

Append to `cmd/klyx/frontend/src/bridge/crd.ts` (extend the imports to include the new types + `ResourceRef`):

```ts
import { useFleet, CRDGroupDTO, CRDCountDTO, crdCountKey, ResourceRef, InstanceDTO } from "../store/fleet";
```
(merge with the existing import line - do not duplicate `useFleet`)

```ts
type InstancePageDTO = { items: InstanceDTO[]; nextToken: string };

export async function loadInstances(cluster: string, ref: ResourceRef, token?: string): Promise<void> {
  if (!token) useFleet.getState().setInstancesLoading(ref);
  const page = (await CRDService.ListInstances(cluster, ref.group, ref.version, ref.plural, token ?? "")) as InstancePageDTO;
  // Drop a stale page if the user navigated to a different kind meanwhile.
  const cur = useFleet.getState().instances.ref;
  if (!cur || cur.group !== ref.group || cur.plural !== ref.plural) return;
  useFleet.getState().addInstancePage(page.items ?? [], page.nextToken ?? "");
}
```

NOTE: `CRDService.ListInstances` resolves only after the bindings are regenerated in Task 6. Do NOT run `tsc`/`build` here; vitest mocks the bridge in component tests.

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts cmd/klyx/frontend/src/bridge/crd.ts
git commit -m "feat(ui): route resource ref + instances slice + loadInstances bridge"
```

---

## Task 4: `InstanceList` view

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/InstanceList.tsx`, `cmd/klyx/frontend/src/cluster/InstanceList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `cmd/klyx/frontend/src/cluster/InstanceList.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceDTO } from "../store/fleet";
import { InstanceList } from "./InstanceList";

vi.mock("../bridge/crd", () => ({ loadInstances: vi.fn(async () => {}) }));
import { loadInstances } from "../bridge/crd";

const nsRef: ResourceRef = { group: "cilium.io", version: "v2", plural: "ciliumendpoints", kind: "CiliumEndpoint", scope: "Namespaced" };
const clusterRef: ResourceRef = { group: "cilium.io", version: "v2", plural: "ciliumnodes", kind: "CiliumNode", scope: "Cluster" };
const rows: InstanceDTO[] = [
  { namespace: "kube-system", name: "coredns-abc", created: "" },
  { namespace: "monitoring", name: "prometheus-0", created: "" },
];

function seed(ref: ResourceRef, over: Partial<{ rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string }> = {}) {
  useFleet.setState({ instances: { ref, rows, nextToken: "", loading: false, filter: "", ...over } });
}

beforeEach(() => { vi.clearAllMocks(); seed(nsRef); });

describe("InstanceList", () => {
  it("renders rows with namespace for a namespaced kind", () => {
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(getByText("coredns-abc")).toBeTruthy();
    expect(getByText("kube-system")).toBeTruthy();
  });

  it("omits the namespace column for a cluster-scoped kind", () => {
    seed(clusterRef, { rows: [{ namespace: "", name: "node-1", created: "" }] });
    const { getByText, queryByText } = render(<InstanceList cluster="x" resource={clusterRef} />);
    expect(getByText("node-1")).toBeTruthy();
    expect(queryByText("namespace")).toBeNull(); // no namespace column header
  });

  it("shows Load more only when nextToken is set and calls the bridge with it", () => {
    seed(nsRef, { nextToken: "tok-2" });
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    fireEvent.click(getByText(/load more/i));
    expect(loadInstances).toHaveBeenCalledWith("x", nsRef, "tok-2");
  });

  it("hides Load more when there is no nextToken", () => {
    const { queryByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(queryByText(/load more/i)).toBeNull();
  });

  it("filters rows by substring", () => {
    seed(nsRef, { filter: "prometheus" });
    const { queryByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(queryByText("prometheus-0")).toBeTruthy();
    expect(queryByText("coredns-abc")).toBeNull();
  });

  it("shows the empty state when there are no rows and not loading", () => {
    seed(nsRef, { rows: [] });
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(getByText(/No instances/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceList.test.tsx`
Expected: FAIL - cannot find module `./InstanceList`.

- [ ] **Step 3: Implement `src/cluster/InstanceList.tsx`**

```tsx
import { useEffect } from "react";
import { useFleet, ResourceRef } from "../store/fleet";
import { loadInstances } from "../bridge/crd";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function age(created: string): string {
  if (!created) return "";
  const ms = Date.now() - Date.parse(created);
  if (Number.isNaN(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function InstanceList({ cluster, resource }: { cluster: string; resource: ResourceRef }) {
  const instances = useFleet((s) => s.instances);
  const setFilter = useFleet((s) => s.setInstanceFilter);

  useEffect(() => {
    void loadInstances(cluster, resource);
    return () => useFleet.getState().clearInstances();
  }, [cluster, resource.group, resource.version, resource.plural]);

  const namespaced = resource.scope === "Namespaced";
  const cols = namespaced ? "1fr 1.4fr 70px" : "1fr 70px";

  const isCurrent = instances.ref && instances.ref.group === resource.group && instances.ref.plural === resource.plural;
  const all = isCurrent ? instances.rows : [];
  const q = instances.filter.toLowerCase();
  const rows = all
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q))
    .sort((a, b) => (a.namespace === b.namespace ? a.name.localeCompare(b.name) : a.namespace.localeCompare(b.namespace)));

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{resource.kind}</div>
        <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 6px", borderRadius: 3 }}>{resource.scope.toLowerCase()}</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{all.length} loaded</span>
        <div style={{ flex: 1 }} />
        <input
          value={instances.filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="name, namespace…"
          style={{ width: 200, height: 28, paddingLeft: 10, fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
        />
      </div>

      {instances.loading && all.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading instances…</div>
      ) : all.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No instances of this kind.</div>
      ) : (
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, padding: "6px 12px", background: "var(--color-background-secondary)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>
            {namespaced && <span>namespace</span>}
            <span>name</span>
            <span>age</span>
          </div>
          {rows.map((r) => (
            <div key={`${r.namespace}/${r.name}`} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11 }}>
              {namespaced && <span style={{ color: "var(--color-text-secondary)", ...ellipsis }}>{r.namespace}</span>}
              <span style={{ fontFamily: "var(--font-mono)", ...ellipsis }}>{r.name}</span>
              <span style={{ color: "var(--color-text-tertiary)" }}>{age(r.created)}</span>
            </div>
          ))}
        </div>
      )}

      {isCurrent && instances.nextToken && (
        <button
          onClick={() => void loadInstances(cluster, resource, instances.nextToken)}
          style={{ marginTop: 10, padding: "5px 12px", fontSize: 12, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}
        >
          Load more
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceList.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/InstanceList.tsx cmd/klyx/frontend/src/cluster/InstanceList.test.tsx
git commit -m "feat(ui): InstanceList - paginated metadata rows, filter, load-more"
```

---

## Task 5: Wiring - kind click, ClusterDetail, Breadcrumb

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/CRDBrowser.tsx` + `CRDBrowser.test.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`
- Modify: `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` + `Breadcrumb.test.tsx`

- [ ] **Step 1: Write the failing tests**

(a) Add to `cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx` (inside the `describe`):

```tsx
it("clicking a kind opens the resource drill-in", () => {
  useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources" }, crd: { ...useFleet.getState().crd, expanded: ["cilium.io"] } });
  const { getByText } = render(<CRDBrowser cluster="x" />);
  fireEvent.click(getByText("CiliumEndpoint"));
  const r = useFleet.getState().route;
  expect(r.name === "cluster" && r.resource?.kind).toBe("CiliumEndpoint");
  expect(r.name === "cluster" && r.resource?.plural).toBe("ciliumendpoints");
});
```
(The `beforeEach` already seeds `crd` with the two cilium kinds; ensure the cluster route is set so `openResource` applies. `fireEvent` is already imported in this file.)

(b) `cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx` already exists with imports (`describe/it/expect`, `render`, `useFleet`, `Breadcrumb`) and a `describe("Breadcrumb", ...)` block. Append this `it` INSIDE that existing block (no new imports):

```tsx
  it("shows the kind crumb when a resource is selected", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource: { group: "cilium.io", version: "v2", plural: "ciliumendpoints", kind: "CiliumEndpoint", scope: "Namespaced" } } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("CiliumEndpoint")).toBeTruthy();
    expect(getByText("Resources")).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/CRDBrowser.test.tsx src/chrome/Breadcrumb.test.tsx`
Expected: FAIL - kind click does not set `resource`; breadcrumb has no kind crumb.

- [ ] **Step 3: Make CRDBrowser kind rows clickable**

In `cmd/klyx/frontend/src/cluster/CRDBrowser.tsx`, in the `Section` component add the action selector near the other `useFleet` hooks:

```tsx
  const openResource = useFleet((s) => s.openResource);
```
Change the kind row `<div key={...}>` (currently `CRDBrowser.tsx:148`) to be clickable - add `onClick` and a pointer cursor:

```tsx
          <div
            key={`${k.group}/${k.kind}`}
            onClick={() => openResource({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, scope: k.scope })}
            style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px 1fr", gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, cursor: "pointer" }}
          >
```
(Leave the inner row cells unchanged.)

- [ ] **Step 4: Wire `ClusterDetail.tsx`**

Add the import:
```tsx
import { InstanceList } from "./InstanceList";
```
Change the `resources` branch (currently `ClusterDetail.tsx:25`):
```tsx
  if (route.section === "resources") {
    return route.resource
      ? <InstanceList cluster={cluster.name} resource={route.resource} />
      : <CRDBrowser cluster={cluster.name} />;
  }
```

- [ ] **Step 5: Wire `Breadcrumb.tsx`**

Add `closeResource` to the selectors:
```tsx
  const closeResource = useFleet((s) => s.closeResource);
```
Replace the section block (currently `Breadcrumb.tsx:23-28`) so the Resources crumb is a back button when a resource is open, and the kind is appended:
```tsx
      {route.section !== "overview" && (
        <>
          <span>/</span>
          {route.resource ? (
            <button onClick={closeResource} style={crumbBtn}>{SECTION_LABELS[route.section]}</button>
          ) : (
            <span style={{ color: "var(--color-text-primary)" }}>{SECTION_LABELS[route.section]}</span>
          )}
          {route.resource && (
            <>
              <span>/</span>
              <span style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>{route.resource.kind}</span>
            </>
          )}
        </>
      )}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/CRDBrowser.test.tsx src/chrome/Breadcrumb.test.tsx` then `npx vitest run` (whole suite green).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/CRDBrowser.tsx cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx
git commit -m "feat(ui): drill from kind into InstanceList - click, route, breadcrumb"
```

---

## Task 6: Regenerate bindings, full build, verification

- [ ] **Step 1: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, race + vet clean.

- [ ] **Step 2: Regenerate bindings + frontend suite + full native build**

```bash
cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
grep -rn "ListInstances" frontend/bindings/github.com/moomora/klyx/internal/appbridge/ | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show `ListInstances`; vitest all green; `tsc` clean; `wails3 build` exit 0.

- [ ] **Step 3: Native handoff (manual, owner)**

On `homelab-nelli`: Resources → expand `cilium.io` → click `CiliumEndpoint` → confirm the instance list loads, paginates with **Load more** (on the prod AKS clusters where there are thousands), the filter narrows rows, the breadcrumb shows `… / Resources / CiliumEndpoint` and the `Resources` crumb returns to the browser; click a cluster-scoped kind (`CiliumNode`) and confirm no namespace column.

- [ ] **Step 4: Commit any build-surfaced fixes** (skip if none)

```bash
git add -A && git commit -m "chore(m4-b): verification fixes"
```

---

## Self-review notes

- **Spec coverage:** §2 data layer → Task 1. §3 appbridge → Task 2. §4 route + slice → Task 3. §5 view + wiring → Tasks 4-5. §6 testing → each task + Task 6 native.
- **No watch / no bulk:** `ListInstances` is one metadata-only list page per call; the view's cleanup `clearInstances` on unmount drops retained rows. Consistent with M4-a.
- **Stale-page guard:** `loadInstances` re-checks `instances.ref` after the await and drops a page whose kind no longer matches; the view also guards rows via `isCurrent`. Prevents a late page from a previous kind appearing.
- **`setSection` resource-clear:** changing section drops `resource` (Task 3d), so leaving Resources via the sidebar/section nav can't strand a dangling drill-in.
- **Binding timing:** `bridge/crd.ts` references `CRDService.ListInstances` before Task 6 regenerates bindings; vitest mocks the bridge, so unit tests pass; the full `tsc`/build is Task 6 (same pattern as M3-c / M4-a).
- **Type consistency:** `InstanceMeta` (Go crd) → `InstanceDTO` (Go appbridge json `namespace/name/created`) → `InstanceDTO` (TS). `ResourceRef` carries `scope` used for the namespace-column decision. `ListInstances(ctx, group, version, plural, limit, continueToken)` identical on `Conn`, `CRDConn`, `ClusterConn`, both fakes.
