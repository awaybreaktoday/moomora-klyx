# Klyx GitOps M3-b Implementation Plan (resource detail + inventory)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline detail drilldown to the GitOps view - click a Flux resource to expand its revisions (with apply-failure flag), Ready/Healthy conditions, and managed-object inventory - all parsed from the CR the gitops watch already holds (no new API reads).

**Architecture:** A pure `flux.ParseDetail` extracts conditions/revisions/inventory from the watched unstructured object; `ClusterConn.GitOpsObject` returns that object from the live informer store; `GitOpsService.GetResourceDetail` (a new method on the already-registered service) projects it to a DTO on demand; the React GitOps rows expand to render it.

**Tech Stack:** Go + client-go (`unstructured`); React + TS + Zustand. Frontend root `cmd/klyx/frontend/`. No `main.go` change - `GetResourceDetail` binds automatically on the next `wails3 build`.

**Spec:** `docs/superpowers/specs/2026-06-04-klyx-gitops-resource-detail-design.md`

**Out of scope:** field-level YAML diff (Git-render milestone), per-inventory-object live readiness (kstatus follow-up).

---

### Task 1: `flux.ParseDetail` + detail types

**Files:**
- Modify: `internal/gitops/flux/flux.go`
- Test: `internal/gitops/flux/detail_test.go`

- [ ] **Step 1: Write the failing test** — `internal/gitops/flux/detail_test.go`:
```go
package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ksDetailObj() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status": map[string]interface{}{
			"lastAppliedRevision":   "main@sha1:abc",
			"lastAttemptedRevision": "main@sha1:abc",
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "reason": "ReconciliationSucceeded", "message": "Applied revision: main@sha1:abc"},
				map[string]interface{}{"type": "Healthy", "status": "True", "reason": "Succeeded", "message": "Health check passed"},
			},
			"inventory": map[string]interface{}{
				"entries": []interface{}{
					map[string]interface{}{"id": "flux-system_infrastructure_kustomize.toolkit.fluxcd.io_Kustomization", "v": "v1"},
					map[string]interface{}{"id": "monitoring_my-cm__ConfigMap", "v": "v1"},
					map[string]interface{}{"id": "_cluster-admin_rbac.authorization.k8s.io_ClusterRole", "v": "v1"},
				},
			},
		},
	}}
}

func TestParseDetailKustomization(t *testing.T) {
	d := ParseDetail(ksDetailObj())
	if d.Kind != KustomizationKind || d.Name != "flux-system" {
		t.Fatalf("identity: %+v", d)
	}
	if d.AppliedRevision != "main@sha1:abc" || d.AttemptedRevision != "main@sha1:abc" {
		t.Fatalf("revisions: %+v", d)
	}
	if len(d.Conditions) != 2 || d.Conditions[0].Type != "Ready" || d.Conditions[1].Type != "Healthy" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if d.Conditions[1].Message != "Health check passed" {
		t.Fatalf("healthy message: %q", d.Conditions[1].Message)
	}
	if len(d.Inventory) != 3 {
		t.Fatalf("inventory len: %d", len(d.Inventory))
	}
	// namespaced + group
	if d.Inventory[0] != (InventoryEntry{Namespace: "flux-system", Name: "infrastructure", Group: "kustomize.toolkit.fluxcd.io", Kind: "Kustomization", Version: "v1"}) {
		t.Fatalf("entry0: %+v", d.Inventory[0])
	}
	// empty group (core kind)
	if d.Inventory[1] != (InventoryEntry{Namespace: "monitoring", Name: "my-cm", Group: "", Kind: "ConfigMap", Version: "v1"}) {
		t.Fatalf("entry1: %+v", d.Inventory[1])
	}
	// cluster-scoped (empty namespace)
	if d.Inventory[2] != (InventoryEntry{Namespace: "", Name: "cluster-admin", Group: "rbac.authorization.k8s.io", Kind: "ClusterRole", Version: "v1"}) {
		t.Fatalf("entry2: %+v", d.Inventory[2])
	}
}

func TestParseDetailHelmReleaseNoInventory(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2",
		"kind":       "HelmRelease",
		"metadata":   map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "message": "Helm install succeeded"},
			},
		},
	}}
	d := ParseDetail(u)
	if d.Kind != HelmReleaseKind {
		t.Fatalf("kind: %q", d.Kind)
	}
	if len(d.Inventory) != 0 {
		t.Fatalf("helmrelease should have no inventory, got %d", len(d.Inventory))
	}
	if len(d.Conditions) != 1 {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/gitops/flux/ -run TestParseDetail -v`
Expected: FAIL - undefined `ParseDetail`/`Detail`/`Condition`/`InventoryEntry`.

- [ ] **Step 3: Implement (append to `internal/gitops/flux/flux.go`)**

Add `"strings"` to the import block if not present, then add:
```go
type Condition struct {
	Type    string
	Status  string
	Reason  string
	Message string
}

type InventoryEntry struct {
	Group     string
	Version   string
	Kind      string
	Namespace string
	Name      string
}

type Detail struct {
	Kind              Kind
	Namespace         string
	Name              string
	AppliedRevision   string
	AttemptedRevision string
	Conditions        []Condition
	Inventory         []InventoryEntry
}

// ParseDetail extracts the detail view from a watched Flux CR. Inventory is
// parsed only for Kustomizations (HelmRelease CRs carry none).
func ParseDetail(u *unstructured.Unstructured) Detail {
	d := Detail{Kind: Kind(u.GetKind()), Namespace: u.GetNamespace(), Name: u.GetName()}
	d.AppliedRevision, _, _ = unstructured.NestedString(u.Object, "status", "lastAppliedRevision")
	d.AttemptedRevision, _, _ = unstructured.NestedString(u.Object, "status", "lastAttemptedRevision")

	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, c := range conds {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cond := Condition{}
		cond.Type, _ = cm["type"].(string)
		cond.Status, _ = cm["status"].(string)
		cond.Reason, _ = cm["reason"].(string)
		cond.Message, _ = cm["message"].(string)
		d.Conditions = append(d.Conditions, cond)
	}

	entries, _, _ := unstructured.NestedSlice(u.Object, "status", "inventory", "entries")
	for _, e := range entries {
		em, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := em["id"].(string)
		v, _ := em["v"].(string)
		if ie, ok := parseInventoryID(id, v); ok {
			d.Inventory = append(d.Inventory, ie)
		}
	}
	return d
}

// parseInventoryID parses Flux's inventory id "<namespace>_<name>_<group>_<kind>".
// Namespace is empty for cluster-scoped objects; group is empty for core kinds.
// k8s names/namespaces/groups/kinds contain no underscore, so a 4-way split is safe.
func parseInventoryID(id, version string) (InventoryEntry, bool) {
	parts := strings.SplitN(id, "_", 4)
	if len(parts) != 4 {
		return InventoryEntry{}, false
	}
	return InventoryEntry{
		Namespace: parts[0],
		Name:      parts[1],
		Group:     parts[2],
		Kind:      parts[3],
		Version:   version,
	}, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/gitops/flux/ -v`
Expected: PASS (new detail tests + the existing parser tests).

- [ ] **Step 5: Commit**

```bash
git add internal/gitops/flux/flux.go internal/gitops/flux/detail_test.go
git commit -m "$(printf 'feat: flux.ParseDetail - conditions, revisions, inventory\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `ClusterConn.GitOpsObject` (live store lookup)

**Files:**
- Modify: `internal/fleet/conn.go` (extend `Conn` interface)
- Modify: `internal/fleet/gitopswatch.go` (add `GitOpsObject`)
- Modify: `internal/fleet/registry_test.go` (fakeConn stub)
- Test: `internal/fleet/gitopswatch_test.go`

- [ ] **Step 1: Write the failing test** — append to `internal/fleet/gitopswatch_test.go`:
```go
func TestGitOpsObjectReturnsWatchedObject(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()
	scheme := runtime.NewScheme()
	ksGVR := schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	gvrToListKind := map[schema.GroupVersionResource]string{
		ksGVR: "KustomizationList",
		{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}: "HelmReleaseList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToListKind, ksObj("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{})
	c.ctx = ctx
	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		_, ok := c.GitOpsObject("Kustomization", "flux-system", "flux-system")
		return ok
	})
	if _, ok := c.GitOpsObject("Kustomization", "flux-system", "nope"); ok {
		t.Fatal("did not expect to find a nonexistent object")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestGitOpsObjectReturns -v`
Expected: FAIL - `GitOpsObject` undefined (and the interface won't compile once referenced).

- [ ] **Step 3: Add `GitOpsObject` to `internal/fleet/gitopswatch.go`**

Add `"github.com/moomora/klyx/internal/gitops/flux"` is already imported; ensure `"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"` is imported (it is). Add:
```go
// GitOpsObject returns the watched Flux object of the given kind by namespace/name
// from the live informer store. false if the watch is closed or not found.
func (c *ClusterConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	c.mu.RLock()
	g := c.gitops
	c.mu.RUnlock()
	if g == nil {
		return nil, false
	}
	var inf cache.SharedIndexInformer
	switch flux.Kind(kind) {
	case flux.KustomizationKind:
		inf = g.ksInf
	case flux.HelmReleaseKind:
		inf = g.hrInf
	default:
		return nil, false
	}
	if inf == nil {
		return nil, false
	}
	for _, obj := range inf.GetStore().List() {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			if u.GetNamespace() == namespace && u.GetName() == name {
				return u, true
			}
		}
	}
	return nil, false
}
```

- [ ] **Step 4: Extend the `Conn` interface + fakeConn stub**

In `internal/fleet/conn.go`, add to the `Conn` interface (after `GitOpsResources() []flux.Resource`):
```go
	GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
```
Add the import `"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"` to conn.go (for the interface signature).
In `internal/fleet/registry_test.go`, add to `fakeConn` (it already imports flux; add unstructured import):
```go
func (f *fakeConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	return nil, false
}
```

- [ ] **Step 5: Run tests + race**

Run: `go test ./internal/fleet/ -run 'TestGitOpsObject|TestOpenGitOps|TestRegistry' -v` then `go test -race ./internal/fleet/`
Expected: PASS, no race.

- [ ] **Step 6: Commit**

```bash
git add internal/fleet/conn.go internal/fleet/gitopswatch.go internal/fleet/registry_test.go internal/fleet/gitopswatch_test.go
git commit -m "$(printf 'feat: ClusterConn.GitOpsObject - live store lookup for detail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: appbridge ResourceDetailDTO + GetResourceDetail

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (detail DTOs + `toDetailDTO`)
- Modify: `internal/appbridge/gitops_service.go` (`GitOpsConn.GitOpsObject` + `GetResourceDetail`)
- Test: `internal/appbridge/gitops_detail_test.go`

- [ ] **Step 1: Write the failing test** — `internal/appbridge/gitops_detail_test.go`:
```go
package appbridge

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToDetailDTOApplyFailed(t *testing.T) {
	d := flux.Detail{
		Kind: flux.KustomizationKind, Namespace: "flux-system", Name: "x",
		AppliedRevision: "main@a", AttemptedRevision: "main@b",
		Conditions: []flux.Condition{{Type: "Ready", Status: "False", Reason: "BuildFailed", Message: "boom"}},
		Inventory:  []flux.InventoryEntry{{Namespace: "ns", Name: "cm", Kind: "ConfigMap", Version: "v1"}},
	}
	dto := toDetailDTO(d)
	if !dto.ApplyFailed {
		t.Fatal("want ApplyFailed when attempted != applied")
	}
	if len(dto.Conditions) != 1 || dto.Conditions[0].Reason != "BuildFailed" {
		t.Fatalf("conditions: %+v", dto.Conditions)
	}
	if len(dto.Inventory) != 1 || dto.Inventory[0].Kind != "ConfigMap" {
		t.Fatalf("inventory: %+v", dto.Inventory)
	}
}

func TestToDetailDTOApplyOK(t *testing.T) {
	dto := toDetailDTO(flux.Detail{AppliedRevision: "main@a", AttemptedRevision: "main@a"})
	if dto.ApplyFailed {
		t.Fatal("want ApplyFailed false when equal")
	}
}

func TestGetResourceDetailReadsConn(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status": map[string]interface{}{
			"lastAppliedRevision": "main@a", "lastAttemptedRevision": "main@a",
			"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
		},
	}}
	conn := &fakeGitOpsConn{obj: obj}
	lookup := func(name string) (GitOpsConn, bool) {
		if name == "x" {
			return conn, true
		}
		return nil, false
	}
	svc := NewGitOpsService(lookup, &fakeEmitter{}, timeNowUTC, 0)
	dto := svc.GetResourceDetail("x", "Kustomization", "flux-system", "flux-system")
	if dto.Name != "flux-system" || dto.Kind != "Kustomization" {
		t.Fatalf("detail: %+v", dto)
	}

	empty := svc.GetResourceDetail("ghost", "Kustomization", "a", "b")
	if empty.Name != "" {
		t.Fatalf("want zero DTO for unknown cluster, got %+v", empty)
	}
}
```
Add a `timeNowUTC` helper at the bottom of this test file (or reuse `time.Now` directly): `func timeNowUTC() time.Time { return time.Now() }` with `import "time"`. (If `time` ends up unused because interval 0 is fine, drop it - but `NewGitOpsService` needs a `now func() time.Time`.)

- [ ] **Step 2: Extend `fakeGitOpsConn`** in `internal/appbridge/gitops_service_test.go`

Add the `obj` field and the `GitOpsObject` method:
```go
// add to the fakeGitOpsConn struct:
	obj *unstructured.Unstructured

// add the method:
func (f *fakeGitOpsConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	if f.obj == nil {
		return nil, false
	}
	return f.obj, true
}
```
Add `"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"` to that test file's imports.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestToDetailDTO|TestGetResourceDetail' -v`
Expected: FAIL - undefined `toDetailDTO`/`ResourceDetailDTO`/`GetResourceDetail`; `GitOpsConn` missing `GitOpsObject`.

- [ ] **Step 4: Implement the DTOs in `internal/appbridge/gitops_dto.go`**

Append:
```go
type ConditionDTO struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type InventoryEntryDTO struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type ResourceDetailDTO struct {
	Kind              string              `json:"kind"`
	Namespace         string              `json:"namespace"`
	Name              string              `json:"name"`
	AppliedRevision   string              `json:"appliedRevision"`
	AttemptedRevision string              `json:"attemptedRevision"`
	ApplyFailed       bool                `json:"applyFailed"`
	Conditions        []ConditionDTO      `json:"conditions"`
	Inventory         []InventoryEntryDTO `json:"inventory"`
}

func toDetailDTO(d flux.Detail) ResourceDetailDTO {
	out := ResourceDetailDTO{
		Kind:              string(d.Kind),
		Namespace:         d.Namespace,
		Name:              d.Name,
		AppliedRevision:   d.AppliedRevision,
		AttemptedRevision: d.AttemptedRevision,
		ApplyFailed:       d.AttemptedRevision != "" && d.AttemptedRevision != d.AppliedRevision,
	}
	for _, c := range d.Conditions {
		out.Conditions = append(out.Conditions, ConditionDTO{Type: c.Type, Status: c.Status, Reason: c.Reason, Message: c.Message})
	}
	for _, e := range d.Inventory {
		out.Inventory = append(out.Inventory, InventoryEntryDTO{Group: e.Group, Version: e.Version, Kind: e.Kind, Namespace: e.Namespace, Name: e.Name})
	}
	return out
}
```

- [ ] **Step 5: Implement `GetResourceDetail` in `internal/appbridge/gitops_service.go`**

Add `"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"` to the imports. Add the method to the `GitOpsConn` interface:
```go
type GitOpsConn interface {
	OpenGitOps()
	CloseGitOps()
	GitOpsResources() []flux.Resource
	GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
}
```
Add the bound method:
```go
// GetResourceDetail returns the detail view for one Flux resource from the live
// watch store. Zero-value DTO when the cluster/object isn't available.
func (s *GitOpsService) GetResourceDetail(cluster, kind, namespace, name string) ResourceDetailDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ResourceDetailDTO{}
	}
	u, ok := conn.GitOpsObject(kind, namespace, name)
	if !ok {
		return ResourceDetailDTO{}
	}
	return toDetailDTO(flux.ParseDetail(u))
}
```

- [ ] **Step 6: Run tests + race**

Run: `go test ./internal/appbridge/ -race -v`
Expected: PASS (detail tests + existing), no race.

- [ ] **Step 7: Commit**

```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_service.go internal/appbridge/gitops_detail_test.go internal/appbridge/gitops_service_test.go
git commit -m "$(printf 'feat: appbridge ResourceDetailDTO + GetResourceDetail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Frontend store detail slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts`
- Test: `cmd/klyx/frontend/src/store/gitops_detail.test.ts`

- [ ] **Step 1: Write the failing store test** — `cmd/klyx/frontend/src/store/gitops_detail.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useFleet, ResourceDetailDTO } from "./fleet";

const detail: ResourceDetailDTO = {
  kind: "Kustomization", namespace: "flux-system", name: "flux-system",
  appliedRevision: "main@a", attemptedRevision: "main@a", applyFailed: false,
  conditions: [{ type: "Ready", status: "True", reason: "ok", message: "applied" }],
  inventory: [{ group: "", version: "v1", kind: "ConfigMap", namespace: "ns", name: "cm" }],
};

beforeEach(() => useFleet.setState({ gitops: { cluster: null, resources: [], loading: false, expandedKey: null, detail: null } }));

describe("gitops detail store", () => {
  it("expand sets the key and collapse clears", () => {
    useFleet.getState().expand("Kustomization/flux-system/flux-system");
    expect(useFleet.getState().gitops.expandedKey).toBe("Kustomization/flux-system/flux-system");
    useFleet.getState().collapse();
    expect(useFleet.getState().gitops.expandedKey).toBeNull();
    expect(useFleet.getState().gitops.detail).toBeNull();
  });
  it("setDetail stores the detail", () => {
    useFleet.getState().setDetail(detail);
    expect(useFleet.getState().gitops.detail?.name).toBe("flux-system");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: from `cmd/klyx/frontend/`: `npx vitest run src/store/gitops_detail.test.ts`
Expected: FAIL - `ResourceDetailDTO`/`expand`/`collapse`/`setDetail`/`expandedKey` undefined.

- [ ] **Step 3: Extend the store `cmd/klyx/frontend/src/store/fleet.ts`**

Add the types (after `FluxResourceDTO`):
```ts
export type ConditionDTO = { type: string; status: string; reason: string; message: string };
export type InventoryEntryDTO = { group: string; version: string; kind: string; namespace: string; name: string };
export type ResourceDetailDTO = {
  kind: string;
  namespace: string;
  name: string;
  appliedRevision: string;
  attemptedRevision: string;
  applyFailed: boolean;
  conditions: ConditionDTO[];
  inventory: InventoryEntryDTO[];
};
```
Extend `GitOpsSlice`:
```ts
export type GitOpsSlice = {
  cluster: string | null;
  resources: FluxResourceDTO[];
  loading: boolean;
  expandedKey: string | null;
  detail: ResourceDetailDTO | null;
};
```
Add actions to `FleetState`:
```ts
  expand: (key: string) => void;
  collapse: () => void;
  setDetail: (d: ResourceDetailDTO) => void;
```
Update the initial gitops value and the existing gitops setters to include the new fields, and add the actions in the `create(...)` body:
```ts
  gitops: { cluster: null, resources: [], loading: false, expandedKey: null, detail: null },
  setGitOps: (cluster, resources) => set((s) => ({ gitops: { ...s.gitops, cluster, resources, loading: false } })),
  setGitOpsLoading: (cluster) => set((s) => ({ gitops: { ...s.gitops, cluster, resources: [], loading: true } })),
  clearGitOps: () => set({ gitops: { cluster: null, resources: [], loading: false, expandedKey: null, detail: null } }),
  expand: (key) => set((s) => ({ gitops: { ...s.gitops, expandedKey: key, detail: null } })),
  collapse: () => set((s) => ({ gitops: { ...s.gitops, expandedKey: null, detail: null } })),
  setDetail: (d) => set((s) => ({ gitops: { ...s.gitops, detail: d } })),
```
(Note: `setGitOps`/`setGitOpsLoading` now spread `...s.gitops` so they preserve `expandedKey`/`detail` across live updates - important so an open panel isn't reset every tick.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/store/gitops_detail.test.ts` and `npx vitest run src/store/gitops.test.ts`
Expected: both PASS (the existing gitops store test still passes with the spread setters).

- [ ] **Step 5: Add `getResourceDetail` to `cmd/klyx/frontend/src/bridge/gitops.ts`**

Add the `GetResourceDetail` import usage (same `GitOpsService` binding) and:
```ts
import { useFleet, FluxResourceDTO, ResourceDetailDTO } from "../store/fleet";
// ... existing imports (GitOpsService, Events) ...

export async function getResourceDetail(cluster: string, kind: string, namespace: string, name: string): Promise<void> {
  const d = (await GitOpsService.GetResourceDetail(cluster, kind, namespace, name)) as ResourceDetailDTO;
  if (d && d.name) {
    useFleet.getState().setDetail(d);
  }
}
```
(Keep `openGitOps`/`closeGitOps` as they are.)

- [ ] **Step 6: Build + commit**

Run: `npm run build`
```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/gitops_detail.test.ts cmd/klyx/frontend/src/bridge/gitops.ts
git commit -m "$(printf 'feat: gitops detail store slice + getResourceDetail bridge\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Expandable rows + detail panel

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Test: `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`

- [ ] **Step 1: Add failing tests** — append to `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`. Extend the existing `vi.mock("../bridge/gitops", ...)` to also export `getResourceDetail`:
```tsx
// update the mock at the top of the file to:
vi.mock("../bridge/gitops", () => ({
  openGitOps: async () => () => {},
  closeGitOps: async () => {},
  getResourceDetail: async () => {},
}));
```
Add these tests (the `res`/`cluster` helpers already exist in the file):
```tsx
it("expands a row and renders its detail from the store", () => {
  useFleet.setState({
    clusters: [cluster("Healthy")],
    gitops: {
      cluster: "x",
      resources: [res({ kind: "Kustomization", namespace: "flux-system", name: "flux-system" })],
      loading: false,
      expandedKey: "Kustomization/flux-system/flux-system",
      detail: {
        kind: "Kustomization", namespace: "flux-system", name: "flux-system",
        appliedRevision: "main@a", attemptedRevision: "main@a", applyFailed: false,
        conditions: [
          { type: "Ready", status: "True", reason: "ok", message: "Applied revision main@a" },
          { type: "Healthy", status: "True", reason: "Succeeded", message: "Health check passed" },
        ],
        inventory: [{ group: "", version: "v1", kind: "ConfigMap", namespace: "monitoring", name: "my-cm" }],
      },
    },
  });
  const { getByText } = render(<GitOps cluster="x" />);
  expect(getByText(/Health check passed/i)).toBeTruthy();
  expect(getByText("ConfigMap · monitoring/my-cm")).toBeTruthy();
});

it("shows an apply-failed line when applyFailed", () => {
  useFleet.setState({
    clusters: [cluster("Healthy")],
    gitops: {
      cluster: "x",
      resources: [res({ kind: "Kustomization", namespace: "flux-system", name: "x" })],
      loading: false,
      expandedKey: "Kustomization/flux-system/x",
      detail: {
        kind: "Kustomization", namespace: "flux-system", name: "x",
        appliedRevision: "main@a", attemptedRevision: "main@b", applyFailed: true,
        conditions: [], inventory: [],
      },
    },
  });
  const { getByText } = render(<GitOps cluster="x" />);
  expect(getByText(/apply failed at/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: from `cmd/klyx/frontend/`: `npx vitest run src/cluster/GitOps.test.tsx`
Expected: FAIL - the detail panel isn't rendered yet.

- [ ] **Step 3: Rewrite `cmd/klyx/frontend/src/cluster/GitOps.tsx`**

Full file (extends the M3-a view with expand + detail; keeps the summary, loading/empty states, `shortRev`/`ago`/`ellipsis`/`readyColor` from M3-a):
```tsx
import { useEffect } from "react";
import { useFleet, FluxResourceDTO, ResourceDetailDTO } from "../store/fleet";
import { openGitOps, closeGitOps, getResourceDetail } from "../bridge/gitops";

const readyColor: Record<string, string> = {
  Ready: "var(--color-text-success)",
  Reconciling: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unknown: "var(--color-text-tertiary)",
};
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function shortRev(rev: string): string {
  if (!rev) return "";
  const s = rev.replace(/^refs\/heads\//, "");
  const at = s.indexOf("@");
  if (at < 0) return s;
  const branch = s.slice(0, at);
  const sha = s.slice(at + 1).replace(/^sha1:/, "").replace(/^sha256:/, "");
  return `${branch}@${sha.slice(0, 7)}`;
}
function ago(sec: number): string {
  if (sec <= 0) return "";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
const keyOf = (r: { kind: string; namespace: string; name: string }) => `${r.kind}/${r.namespace}/${r.name}`;

export function GitOps({ cluster }: { cluster: string }) {
  const tier = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.gitopsTier ?? "Unknown");
  const gitops = useFleet((s) => s.gitops);
  const expand = useFleet((s) => s.expand);
  const collapse = useFleet((s) => s.collapse);
  const absent = tier === "Absent";

  useEffect(() => {
    if (absent) return;
    let off = () => {};
    openGitOps(cluster).then((u) => (off = u)).catch((e) => console.error("openGitOps", e));
    return () => {
      off();
      void closeGitOps(cluster);
    };
  }, [cluster, absent]);

  // Fetch the open row's detail on expand and refresh it each list tick.
  useEffect(() => {
    if (!gitops.expandedKey) return;
    const r = gitops.resources.find((x) => keyOf(x) === gitops.expandedKey);
    if (r) void getResourceDetail(cluster, r.kind, r.namespace, r.name);
  }, [cluster, gitops.expandedKey, gitops.resources]);

  if (absent) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>No Flux or Argo installed on this cluster.</div>;
  }

  const rows = gitops.cluster === cluster ? gitops.resources : [];
  const ks = rows.filter((r) => r.kind === "Kustomization").length;
  const hr = rows.filter((r) => r.kind === "HelmRelease").length;
  const ready = rows.filter((r) => r.ready === "Ready").length;
  const notReady = rows.length - ready;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
        <span>kustomizations <b style={{ color: "var(--color-text-primary)" }}>{ks}</b></span>
        <span>helmreleases <b style={{ color: "var(--color-text-primary)" }}>{hr}</b></span>
        <span>ready <b style={{ color: "var(--color-text-success)" }}>{ready}</b></span>
        <span>not ready <b style={{ color: notReady ? "var(--color-text-warning)" : "var(--color-text-primary)" }}>{notReady}</b></span>
      </div>

      {gitops.loading && rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading reconciliation state…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No Flux resources found.</div>
      ) : (
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
          {rows.map((r) => {
            const k = keyOf(r);
            const open = gitops.expandedKey === k;
            return (
              <div key={k}>
                <RowSummary r={r} open={open} onClick={() => (open ? collapse() : expand(k))} />
                {open && <DetailPanel resource={r} detail={gitops.detail && keyOf(gitops.detail) === k ? gitops.detail : null} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RowSummary({ r, open, onClick }: { r: FluxResourceDTO; open: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "grid", gridTemplateColumns: "16px minmax(0,1fr) 130px 130px 72px 84px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12, cursor: "pointer", background: open ? "var(--color-background-secondary)" : "transparent" }}>
      <span style={{ color: "var(--color-text-tertiary)" }}>{open ? "▾" : "▸"}</span>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{r.namespace}/{r.name}</span>{" "}
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{r.kind === "Kustomization" ? "ks" : "hr"}</span>
      </div>
      <div style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={r.sourceName}>{r.sourceName}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", ...ellipsis }} title={r.revision}>{shortRev(r.revision)}</div>
      <div style={{ color: "var(--color-text-tertiary)", fontSize: 11, ...ellipsis }}>{ago(r.lastAppliedAgeSeconds)}</div>
      <div style={{ ...ellipsis, color: r.suspended ? "var(--color-text-warning)" : (readyColor[r.ready] ?? "var(--color-text-tertiary)") }}>
        {r.suspended ? "suspended" : r.ready.toLowerCase()}
      </div>
    </div>
  );
}

function DetailPanel({ resource, detail }: { resource: FluxResourceDTO; detail: ResourceDetailDTO | null }) {
  if (!detail) {
    return <div style={{ padding: "6px 12px 12px 38px", fontSize: 12, color: "var(--color-text-secondary)" }}>Loading detail…</div>;
  }
  const condColor = (c: { status: string }) => (c.status === "True" ? "var(--color-text-success)" : c.status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)");
  return (
    <div style={{ padding: "6px 12px 14px 38px", background: "var(--color-background-secondary)", fontSize: 12 }}>
      {detail.applyFailed && (
        <div style={{ color: "var(--color-text-danger)", marginBottom: 8 }}>apply failed at <span style={{ fontFamily: "var(--font-mono)" }}>{shortRev(detail.attemptedRevision)}</span></div>
      )}
      <Section title="Conditions">
        {detail.conditions.length === 0 ? <Muted>none reported</Muted> : detail.conditions.map((c) => (
          <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c), display: "inline-block" }} />
            <span style={{ fontWeight: 500, width: 70 }}>{c.type}</span>
            <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
          </div>
        ))}
      </Section>
      {resource.kind === "Kustomization" ? (
        <Section title={`Inventory (${detail.inventory.length})`}>
          {detail.inventory.length === 0 ? <Muted>no managed objects</Muted> : detail.inventory.map((e) => (
            <div key={`${e.kind}/${e.namespace}/${e.name}`} style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", ...ellipsis }}>
              {e.kind} · {e.namespace ? `${e.namespace}/` : ""}{e.name}
            </div>
          ))}
        </Section>
      ) : (
        <Section title="Inventory"><Muted>no inventory in the HelmRelease CR</Muted></Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{children}</div>
    </div>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--color-text-tertiary)" }}>{children}</span>;
}
```
The `ConfigMap · monitoring/my-cm` format in the inventory matches the test assertion (note the ` · ` separator and `namespace/name`).

- [ ] **Step 4: Run tests + build**

Run: from `cmd/klyx/frontend/`: `npx vitest run` then `npm run build`
Expected: all pass (incl. the two new expand tests + the existing GitOps tests); builds.

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/GitOps.tsx cmd/klyx/frontend/src/cluster/GitOps.test.tsx
git commit -m "$(printf 'feat: expandable GitOps rows with inline resource detail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Full verification + native handoff

- [ ] **Step 1: Go suite + race + vet**

Run: `make test && make vet && go test -race ./internal/...`
Expected: all pass, vet clean, no race.

- [ ] **Step 2: Frontend suite + build + binding regen**

Run: `cd cmd/klyx/frontend && npx vitest run && npm run build`. Then from `cmd/klyx`: `PATH="$HOME/go/bin:$PATH" wails3 build 2>&1 | tail -10` to regenerate the `GitOpsService` binding with the new `GetResourceDetail` method and confirm the whole app builds.
Expected: all tests pass; both builds clean; the generated `gitopsservice.ts` now includes `GetResourceDetail`.

- [ ] **Step 3: Native handoff**

In the report give the user:
```
cd cmd/klyx && export PATH="$HOME/go/bin:$PATH" && KLYX_CONFIG="$HOME/.config/klyx/fleet.yaml" wails3 dev
# Drill into homelab-nelli -> GitOps -> click flux-system (or any Kustomization):
# expect an inline panel with Ready + Healthy conditions and the managed-object
# inventory; HelmReleases show conditions + a no-inventory note. The chevron
# toggles; the panel updates live.
```

---

## Self-Review

**Spec coverage:**
- §3.1 `flux.ParseDetail` (conditions, revisions, inventory incl. cluster-scoped/empty-group) → Task 1. ✓
- §3.2 `ClusterConn.GitOpsObject` store lookup + `Conn` interface → Task 2. ✓
- §4 `ResourceDetailDTO`/`toDetailDTO` (ApplyFailed), `GitOpsConn.GitOpsObject`, `GitOpsService.GetResourceDetail` → Task 3. ✓
- §5 store slice (expandedKey/detail + expand/collapse/setDetail, spread setters preserve open panel), `getResourceDetail` bridge, expandable rows + detail panel (apply-failed, Ready/Healthy, inventory, HR no-inventory note), re-fetch on tick → Tasks 4, 5. ✓
- §6 tests across flux/fleet/appbridge/frontend + native handoff → every task + Task 6. ✓
- No `main.go` change needed (GetResourceDetail binds on rebuild) — Task 6 Step 2 regenerates the binding. ✓

**Placeholder scan:** none. Code is complete in every step.

**Type consistency:** `flux.Detail`/`Condition`/`InventoryEntry`/`ParseDetail` (T1) used by `GitOpsObject` consumers and `toDetailDTO` (T3). `Conn.GitOpsObject` signature (T2) matches `appbridge.GitOpsConn.GitOpsObject` (T3) and the `fakeConn`/`fakeGitOpsConn` stubs. `ResourceDetailDTO` Go json fields (T3: kind/namespace/name/appliedRevision/attemptedRevision/applyFailed/conditions/inventory) match the TS `ResourceDetailDTO` (T4) and the component's usage (T5). `keyOf` format `"<kind>/<namespace>/<name>"` is consistent between the store key, the rows, and the detail-match guard (T5). `expand/collapse/setDetail/expandedKey/detail` consistent across T4, T5.
