# M3-c-i: GitOps Operational Writes + Guardrail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Flux reconcile and suspend/resume writes to the GitOps detail panel, gated by a confirm dialog that requires typing the cluster name for clusters tagged `protected`.

**Architecture:** Approach A - imperative write methods on `ClusterConn` using the dynamic client it already holds, with pure patch-body builders in `internal/gitops/flux`. The guardrail is UI-enforced; the backend exposes each cluster's `protected` flag and returns a clear `ActionResultDTO` (so an RBAC 403 surfaces as a readable message). No new informers. View-in-git is a separate plan (M3-c-ii) and is NOT in this one.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic fake for tests), Wails v3 bound services, React 19 + TypeScript 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **Flux reconcile** = patch the object's annotations with `reconcile.fluxcd.io/requestedAt: <timestamp>`. This is exactly what `flux reconcile kustomization <name>` does (without `--with-source`). The Flux controller sees the annotation change and re-runs the reconcile.
- **Flux suspend/resume** = patch `spec.suspend: true|false`.
- Both are **JSON merge patches** (`types.MergePatchType`) on the unstructured CRD via the dynamic client.
- The dynamic client and an injected `clock.Clock` are already fields on `ClusterConn` (`c.dyn`, `c.clk`). GVR group/version is resolved by the existing `preferredVersion(disc, group, fallback)` helper in `internal/fleet/gitopswatch.go` (fake discovery has no groups, so the fallback version is used in tests).
- `flux.Resource` already has a `Suspended bool` field parsed in `common()`. `flux.Detail` does NOT yet - Task 2 adds it.
- The frontend already renders a "suspended" label in the row summary (`GitOps.tsx` `RowSummary`) and an `env` badge on `ClusterCard`. This plan extends those, it does not invent them.
- `ToDTO(s fleet.Snapshot, cc config.ClusterConfig, now)` already has the `config.ClusterConfig` in hand, so `Environment`/`Protected` need NO `Snapshot` or `ClusterConn` threading - they map straight from `cc` in `ToDTO`.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gitops/flux/actions.go` | Pure patch-body builders + kind→resource map | Create |
| `internal/gitops/flux/actions_test.go` | Tests for the above | Create |
| `internal/gitops/flux/flux.go` | Add `Detail.Suspended` + parse `spec.suspend` | Modify |
| `internal/gitops/flux/detail_test.go` | Suspend-parse test | Modify |
| `internal/fleet/gitopsactions.go` | `ClusterConn.Reconcile` / `SetSuspend` | Create |
| `internal/fleet/gitopsactions_test.go` | Dynamic-fake write tests | Create |
| `internal/fleet/conn.go` | Add the two methods to the `Conn` interface | Modify |
| `internal/fleet/registry_test.go` | Add stubs to `fakeConn` | Modify |
| `internal/appbridge/gitops_dto.go` | `ActionResultDTO` + `ResourceDetailDTO.Suspended` | Modify |
| `internal/appbridge/gitops_service.go` | `GitOpsConn` additions + `Reconcile`/`SetSuspend` methods | Modify |
| `internal/appbridge/gitops_service_test.go` | Fake stubs + action tests | Modify |
| `internal/config/config.go` | `Environment` + `Protected` config fields | Modify |
| `internal/config/config_test.go` | Parse test | Modify |
| `internal/config/testdata/*.yaml` | Fixture with the new fields | Modify/Create |
| `internal/appbridge/dto.go` | Map `Environment`/`Protected` into `ClusterDTO` | Modify |
| `internal/appbridge/dto_test.go` | DTO mapping test | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | DTO types + action-status slice | Modify |
| `cmd/klyx/frontend/src/store/fleet.test.ts` | Action-status reducer test | Modify |
| `cmd/klyx/frontend/src/bridge/gitops.ts` | `reconcile` / `setSuspend` bridge fns | Modify |
| `cmd/klyx/frontend/src/chrome/ConfirmDialog.tsx` | Reusable confirm dialog | Create |
| `cmd/klyx/frontend/src/chrome/ConfirmDialog.test.tsx` | Dialog gating test | Create |
| `cmd/klyx/frontend/src/cluster/GitOps.tsx` | Actions row + toast + suspended badge | Modify |
| `cmd/klyx/frontend/src/cluster/GitOps.test.tsx` | Action interaction tests | Modify |
| `cmd/klyx/frontend/src/fleet/ClusterCard.tsx` | Protected-lock affordance | Modify |
| `cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx` | Lock render test | Modify |

---

## Task 1: Pure Flux action helpers

**Files:**
- Create: `internal/gitops/flux/actions.go`
- Test: `internal/gitops/flux/actions_test.go`

- [ ] **Step 1: Write the failing test**

```go
package flux

import (
	"testing"
	"time"
)

func TestReconcilePatchBytes(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	got := string(ReconcilePatch(now))
	want := `{"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":"2026-06-04T12:00:00Z"}}}`
	if got != want {
		t.Fatalf("want %s, got %s", want, got)
	}
}

func TestSuspendPatchBytes(t *testing.T) {
	if got := string(SuspendPatch(true)); got != `{"spec":{"suspend":true}}` {
		t.Fatalf("suspend true: got %s", got)
	}
	if got := string(SuspendPatch(false)); got != `{"spec":{"suspend":false}}` {
		t.Fatalf("suspend false: got %s", got)
	}
}

func TestResourceForKind(t *testing.T) {
	if r, ok := ResourceForKind(KustomizationKind); !ok || r != "kustomizations" {
		t.Fatalf("kustomization: %q %v", r, ok)
	}
	if r, ok := ResourceForKind(HelmReleaseKind); !ok || r != "helmreleases" {
		t.Fatalf("helmrelease: %q %v", r, ok)
	}
	if _, ok := ResourceForKind(Kind("Bogus")); ok {
		t.Fatal("bogus kind must not resolve")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/gitops/flux/ -run 'TestReconcilePatchBytes|TestSuspendPatchBytes|TestResourceForKind' -v`
Expected: FAIL - `undefined: ReconcilePatch` etc.

- [ ] **Step 3: Write the implementation**

```go
package flux

import (
	"encoding/json"
	"time"
)

// ReconcileRequestedAtAnnotation is the annotation Flux watches to trigger an
// out-of-band reconcile (equivalent to `flux reconcile <kind> <name>`).
const ReconcileRequestedAtAnnotation = "reconcile.fluxcd.io/requestedAt"

// ReconcilePatch builds a JSON merge patch that stamps the reconcile annotation
// with now (RFC3339Nano). Applying it makes the Flux controller re-reconcile.
func ReconcilePatch(now time.Time) []byte {
	body := map[string]any{
		"metadata": map[string]any{
			"annotations": map[string]any{
				ReconcileRequestedAtAnnotation: now.Format(time.RFC3339Nano),
			},
		},
	}
	b, _ := json.Marshal(body) // single-key nested maps: deterministic, never errors
	return b
}

// SuspendPatch builds a JSON merge patch toggling spec.suspend.
func SuspendPatch(suspend bool) []byte {
	body := map[string]any{"spec": map[string]any{"suspend": suspend}}
	b, _ := json.Marshal(body)
	return b
}

// ResourceForKind maps a Flux Kind to its plural resource name for GVR
// construction. ok is false for kinds Klyx does not act on.
func ResourceForKind(k Kind) (string, bool) {
	switch k {
	case KustomizationKind:
		return "kustomizations", true
	case HelmReleaseKind:
		return "helmreleases", true
	default:
		return "", false
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/gitops/flux/ -run 'TestReconcilePatchBytes|TestSuspendPatchBytes|TestResourceForKind' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/gitops/flux/actions.go internal/gitops/flux/actions_test.go
git commit -m "feat(flux): pure reconcile/suspend patch builders + kind->resource map"
```

---

## Task 2: Parse `spec.suspend` into `flux.Detail`

**Files:**
- Modify: `internal/gitops/flux/flux.go` (the `Detail` struct ~135-143 and `ParseDetail` ~147-179)
- Test: `internal/gitops/flux/detail_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/gitops/flux/detail_test.go`:

```go
func TestParseDetailReadsSuspend(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "paused", "namespace": "flux-system"},
		"spec":       map[string]interface{}{"suspend": true},
		"status":     map[string]interface{}{},
	}}
	if d := ParseDetail(u); !d.Suspended {
		t.Fatal("want Suspended=true")
	}

	u2 := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "running", "namespace": "flux-system"},
	}}
	if d := ParseDetail(u2); d.Suspended {
		t.Fatal("want Suspended=false when spec.suspend absent")
	}
}
```

(If `detail_test.go` does not already import `unstructured`, it does - it tests `ParseDetail` which takes an `*unstructured.Unstructured`. Reuse the existing import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/gitops/flux/ -run TestParseDetailReadsSuspend -v`
Expected: FAIL - `d.Suspended undefined (type Detail has no field or method Suspended)`

- [ ] **Step 3: Add the field and parse it**

In `internal/gitops/flux/flux.go`, add `Suspended` to the `Detail` struct:

```go
type Detail struct {
	Kind              Kind
	Namespace         string
	Name              string
	Suspended         bool
	AppliedRevision   string
	AttemptedRevision string
	Conditions        []Condition
	Inventory         []InventoryEntry
}
```

In `ParseDetail`, immediately after the line that sets `d.AttemptedRevision`, add:

```go
	d.Suspended, _, _ = unstructured.NestedBool(u.Object, "spec", "suspend")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/gitops/flux/ -run TestParseDetailReadsSuspend -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/gitops/flux/flux.go internal/gitops/flux/detail_test.go
git commit -m "feat(flux): parse spec.suspend into Detail"
```

---

## Task 3: Thread `Suspended` through `ResourceDetailDTO`

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (the `ResourceDetailDTO` struct ~60-69 and `toDetailDTO` ~71-87)
- Test: `internal/appbridge/gitops_dto_test.go` (exists; append the func)

- [ ] **Step 1: Write the failing test**

Append to the existing `internal/appbridge/gitops_dto_test.go`. It already declares `package appbridge` and imports `flux`; if `flux` is not yet imported there, add `"github.com/moomora/klyx/internal/gitops/flux"`. Add just the function:

```go
func TestToDetailDTOCarriesSuspended(t *testing.T) {
	d := flux.Detail{Kind: flux.KustomizationKind, Name: "x", Namespace: "flux-system", Suspended: true}
	if got := toDetailDTO(d); !got.Suspended {
		t.Fatal("want Suspended=true in DTO")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestToDetailDTOCarriesSuspended -v`
Expected: FAIL - `got.Suspended undefined`

- [ ] **Step 3: Implement**

Add the field to `ResourceDetailDTO` (after `Name`):

```go
	Suspended         bool                `json:"suspended"`
```

In `toDetailDTO`, set it in the struct literal (after `Name: d.Name,`):

```go
		Suspended:         d.Suspended,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/appbridge/ -run TestToDetailDTOCarriesSuspended -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_dto_test.go
git commit -m "feat(appbridge): carry suspended state in ResourceDetailDTO"
```

---

## Task 4: `ClusterConn.Reconcile` and `SetSuspend`

**Files:**
- Create: `internal/fleet/gitopsactions.go`
- Test: `internal/fleet/gitopsactions_test.go`
- Modify: `internal/fleet/conn.go` (the `Conn` interface, lines ~24-32)
- Modify: `internal/fleet/registry_test.go` (`fakeConn`, lines ~13-31)

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/gitopsactions_test.go`:

```go
package fleet

import (
	"context"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/gitops/flux"
)

func ksGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
}

func newActionConn(dyn *fake.FakeDynamicClient) *ClusterConn {
	typed := typedfake.NewSimpleClientset()
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{})
	c.ctx = context.Background()
	return c
}

func seedKustomization(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{},
	}}
}

func dynScheme() *runtime.Scheme {
	s := runtime.NewScheme()
	return s
}

func TestReconcilePatchesAnnotation(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	c := newActionConn(dyn)

	if err := c.Reconcile(context.Background(), "Kustomization", "flux-system", "app"); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	var patched bool
	for _, a := range dyn.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && pa.GetName() == "app" {
			patched = true
			if !strings.Contains(string(pa.GetPatch()), flux.ReconcileRequestedAtAnnotation) {
				t.Fatalf("patch missing annotation: %s", pa.GetPatch())
			}
		}
	}
	if !patched {
		t.Fatal("expected a patch action on app")
	}
}

func TestSetSuspendPatchesSpec(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	c := newActionConn(dyn)

	if err := c.SetSuspend(context.Background(), "Kustomization", "flux-system", "app", true); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	found := false
	for _, a := range dyn.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && strings.Contains(string(pa.GetPatch()), `"suspend":true`) {
			found = true
		}
	}
	if !found {
		t.Fatal("expected a suspend:true patch")
	}
}

func TestReconcileUnknownKindErrors(t *testing.T) {
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), map[schema.GroupVersionResource]string{})
	c := newActionConn(dyn)
	if err := c.Reconcile(context.Background(), "Service", "default", "x"); err == nil {
		t.Fatal("want error for unsupported kind")
	}
}

func TestReconcileSurfacesForbidden(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{ksGVR(): "KustomizationList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedKustomization("app"))
	dyn.PrependReactor("patch", "kustomizations", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "kustomizations"}, "app", nil)
	})
	c := newActionConn(dyn)
	err := c.Reconcile(context.Background(), "Kustomization", "flux-system", "app")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "forbidden") {
		t.Fatalf("want forbidden error, got %v", err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/fleet/ -run 'TestReconcilePatchesAnnotation|TestSetSuspendPatchesSpec|TestReconcileUnknownKindErrors|TestReconcileSurfacesForbidden' -v`
Expected: FAIL - `c.Reconcile undefined` / `c.SetSuspend undefined`

- [ ] **Step 3: Implement the write methods**

Create `internal/fleet/gitopsactions.go`:

```go
package fleet

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// fluxGroupForKind returns the API group + fallback preferred version for a Flux
// kind, used to build the GVR for a write.
func fluxGroupForKind(kind flux.Kind) (group, fallbackVersion string, ok bool) {
	switch kind {
	case flux.KustomizationKind:
		return "kustomize.toolkit.fluxcd.io", "v1", true
	case flux.HelmReleaseKind:
		return "helm.toolkit.fluxcd.io", "v2", true
	default:
		return "", "", false
	}
}

// gvrForKind resolves the served GVR for a Flux kind via discovery (falling back
// to the documented version when discovery has no groups, e.g. in tests).
func (c *ClusterConn) gvrForKind(kind flux.Kind) (schema.GroupVersionResource, error) {
	group, fallback, ok := fluxGroupForKind(kind)
	if !ok {
		return schema.GroupVersionResource{}, fmt.Errorf("unsupported kind %q", kind)
	}
	resource, ok := flux.ResourceForKind(kind)
	if !ok {
		return schema.GroupVersionResource{}, fmt.Errorf("unsupported kind %q", kind)
	}
	version := preferredVersion(c.typed.Discovery(), group, fallback)
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resource}, nil
}

// Reconcile stamps the Flux reconcile annotation so the controller re-reconciles.
func (c *ClusterConn) Reconcile(ctx context.Context, kind, ns, name string) error {
	gvr, err := c.gvrForKind(flux.Kind(kind))
	if err != nil {
		return err
	}
	body := flux.ReconcilePatch(c.clk.Now())
	_, err = c.dyn.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("reconcile %s %s/%s: %w", kind, ns, name, err)
	}
	return nil
}

// SetSuspend toggles spec.suspend on a Flux resource.
func (c *ClusterConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error {
	gvr, err := c.gvrForKind(flux.Kind(kind))
	if err != nil {
		return err
	}
	body := flux.SuspendPatch(suspend)
	_, err = c.dyn.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("set suspend=%v %s %s/%s: %w", suspend, kind, ns, name, err)
	}
	return nil
}
```

- [ ] **Step 4: Add the methods to the `Conn` interface**

In `internal/fleet/conn.go`, extend the `Conn` interface (after `GitOpsObject`):

```go
	Reconcile(ctx context.Context, kind, ns, name string) error
	SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error
```

- [ ] **Step 5: Add stubs to `fakeConn`**

In `internal/fleet/registry_test.go`, after the `GitOpsObject` stub:

```go
func (f *fakeConn) Reconcile(ctx context.Context, kind, ns, name string) error { return nil }
func (f *fakeConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error {
	return nil
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./internal/fleet/ -run 'TestReconcile|TestSetSuspend|Registry' -v`
Expected: PASS (the registry tests still compile and pass with the new interface methods)

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/gitopsactions.go internal/fleet/gitopsactions_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.Reconcile and SetSuspend via dynamic client"
```

---

## Task 5: appbridge action methods + `ActionResultDTO`

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (add `ActionResultDTO`)
- Modify: `internal/appbridge/gitops_service.go` (`GitOpsConn` interface + `Reconcile`/`SetSuspend`)
- Test: `internal/appbridge/gitops_service_test.go` (fake stubs + tests)

- [ ] **Step 1: Write the failing test**

In `internal/appbridge/gitops_service_test.go`, extend `fakeGitOpsConn` with controllable write behaviour and add tests. Add these fields to the `fakeGitOpsConn` struct:

```go
	reconcileErr error
	suspendErr   error
	lastSuspend  bool
```

Add the methods:

```go
func (f *fakeGitOpsConn) Reconcile(ctx context.Context, kind, ns, name string) error {
	return f.reconcileErr
}
func (f *fakeGitOpsConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error {
	f.mu.Lock()
	f.lastSuspend = suspend
	f.mu.Unlock()
	return f.suspendErr
}
```

(Add `"context"` to the test imports.)

Add the tests:

```go
func TestReconcileActionResult(t *testing.T) {
	conn := &fakeGitOpsConn{}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	if r := svc.Reconcile("x", "Kustomization", "flux-system", "app"); !r.OK || r.Error != "" {
		t.Fatalf("want OK, got %+v", r)
	}
}

func TestReconcileActionSurfacesError(t *testing.T) {
	conn := &fakeGitOpsConn{reconcileErr: errors.New("forbidden: cannot patch")}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	r := svc.Reconcile("x", "Kustomization", "flux-system", "app")
	if r.OK || r.Error == "" {
		t.Fatalf("want failure surfaced, got %+v", r)
	}
}

func TestSetSuspendActionPassesFlag(t *testing.T) {
	conn := &fakeGitOpsConn{}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	if r := svc.SetSuspend("x", "Kustomization", "flux-system", "app", true); !r.OK {
		t.Fatalf("want OK, got %+v", r)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if !conn.lastSuspend {
		t.Fatal("expected suspend=true to reach the conn")
	}
}

func TestActionUnknownClusterIsError(t *testing.T) {
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return nil, false }, &fakeEmitter{}, time.Now, time.Second)
	if r := svc.Reconcile("ghost", "Kustomization", "n", "x"); r.OK || r.Error == "" {
		t.Fatalf("want failure for unknown cluster, got %+v", r)
	}
}
```

(Add `"errors"` to the test imports.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestReconcileAction|TestSetSuspendAction|TestActionUnknownCluster' -v`
Expected: FAIL - `svc.Reconcile undefined` and `fakeGitOpsConn` does not satisfy `GitOpsConn`

- [ ] **Step 3: Add `ActionResultDTO`**

In `internal/appbridge/gitops_dto.go`:

```go
// ActionResultDTO is the result of an operational write. Error carries the
// cluster's message (e.g. an RBAC 403) for display.
type ActionResultDTO struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}
```

- [ ] **Step 4: Extend `GitOpsConn` and add the service methods**

In `internal/appbridge/gitops_service.go`, add to the `GitOpsConn` interface:

```go
	Reconcile(ctx context.Context, kind, ns, name string) error
	SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error
```

Add a small helper and the two bound methods (uses the existing `context` import; add `"time"` is already imported):

```go
const actionTimeout = 30 * time.Second

func (s *GitOpsService) Reconcile(cluster, kind, namespace, name string) ActionResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ActionResultDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if err := conn.Reconcile(ctx, kind, namespace, name); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}

func (s *GitOpsService) SetSuspend(cluster, kind, namespace, name string, suspend bool) ActionResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ActionResultDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if err := conn.SetSuspend(ctx, kind, namespace, name, suspend); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/appbridge/ -run 'TestReconcileAction|TestSetSuspendAction|TestActionUnknownCluster' -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_service.go internal/appbridge/gitops_service_test.go
git commit -m "feat(appbridge): GitOpsService.Reconcile/SetSuspend with ActionResultDTO"
```

---

## Task 6: Config `Environment` + `Protected`, mapped into `ClusterDTO`

**Files:**
- Modify: `internal/config/config.go` (`ClusterConfig`, lines ~17-24)
- Test: `internal/config/config_test.go` + a testdata fixture
- Modify: `internal/appbridge/dto.go` (`ClusterDTO` + `ToDTO`)
- Test: `internal/appbridge/dto_test.go`

- [ ] **Step 1: Write the failing config test**

Add a fixture `internal/config/testdata/protected.yaml`:

```yaml
clusters:
  - name: prd-we
    context: prd-we
    environment: prd
    protected: true
  - name: dev-ne
    context: dev-ne
    environment: dev
```

Add to `internal/config/config_test.go`:

```go
func TestLoadParsesEnvironmentAndProtected(t *testing.T) {
	cfg, err := Load("testdata/protected.yaml")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	byName := map[string]ClusterConfig{}
	for _, c := range cfg.Clusters {
		byName[c.Name] = c
	}
	if byName["prd-we"].Environment != "prd" || !byName["prd-we"].Protected {
		t.Fatalf("prd-we: %+v", byName["prd-we"])
	}
	if byName["dev-ne"].Environment != "dev" || byName["dev-ne"].Protected {
		t.Fatalf("dev-ne: %+v", byName["dev-ne"])
	}
}
```

(If the loader function is not named `Load`, use the existing loader name - check the top of `config.go`. The fixture path is relative to the package dir.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/config/ -run TestLoadParsesEnvironmentAndProtected -v`
Expected: FAIL - `Environment`/`Protected` undefined

- [ ] **Step 3: Add the config fields**

In `internal/config/config.go`, extend `ClusterConfig`:

```go
type ClusterConfig struct {
	Name        string            `yaml:"name"`
	Context     string            `yaml:"context"`
	Kubeconfig  string            `yaml:"kubeconfig"`
	Tags        map[string]string `yaml:"tags"`
	Group       string            `yaml:"group"`
	Environment string            `yaml:"environment"`
	Protected   bool              `yaml:"protected"`
	Metrics     *MetricsConfig    `yaml:"metrics"`
}
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `go test ./internal/config/ -run TestLoadParsesEnvironmentAndProtected -v`
Expected: PASS

- [ ] **Step 5: Write the failing DTO test**

Add to `internal/appbridge/dto_test.go`:

```go
func TestToDTOMapsEnvironmentAndProtected(t *testing.T) {
	s := fleet.Snapshot{Name: "prd-we", State: fleet.Synced}
	cc := config.ClusterConfig{Name: "prd-we", Environment: "prd", Protected: true}
	dto := ToDTO(s, cc, time.Now())
	if dto.Env != "prd" {
		t.Fatalf("want env=prd, got %q", dto.Env)
	}
	if !dto.Protected {
		t.Fatal("want protected=true")
	}

	// Environment takes precedence, but a legacy tags["env"] still works as fallback.
	cc2 := config.ClusterConfig{Name: "x", Tags: map[string]string{"env": "stg"}}
	if got := ToDTO(fleet.Snapshot{Name: "x"}, cc2, time.Now()).Env; got != "stg" {
		t.Fatalf("want env fallback=stg, got %q", got)
	}
}
```

- [ ] **Step 6: Run the DTO test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestToDTOMapsEnvironmentAndProtected -v`
Expected: FAIL - `dto.Protected undefined`

- [ ] **Step 7: Map the fields in `ToDTO`**

In `internal/appbridge/dto.go`, add `Protected` to `ClusterDTO` (after `Group`):

```go
	Protected     bool   `json:"protected"`
```

In `ToDTO`, change the `Env` mapping and add `Protected`. Replace `Env: cc.Tags["env"],` with:

```go
		Env:           firstNonEmpty(cc.Environment, cc.Tags["env"]),
		Protected:     cc.Protected,
```

Add the helper at the bottom of `dto.go`:

```go
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
```

- [ ] **Step 8: Run the DTO test to verify it passes**

Run: `go test ./internal/appbridge/ -run TestToDTOMapsEnvironmentAndProtected -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go internal/config/testdata/protected.yaml internal/appbridge/dto.go internal/appbridge/dto_test.go
git commit -m "feat(config): environment + protected cluster fields, mapped into ClusterDTO"
```

---

## Task 7: Frontend store - DTO types + action-status slice

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Test: `cmd/klyx/frontend/src/store/fleet.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `cmd/klyx/frontend/src/store/fleet.test.ts`:

```ts
import { useFleet } from "./fleet";

test("action status set and clear", () => {
  useFleet.getState().setActionStatus({ kind: "success", message: "Reconcile requested" });
  expect(useFleet.getState().actionStatus?.message).toBe("Reconcile requested");
  useFleet.getState().clearActionStatus();
  expect(useFleet.getState().actionStatus).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "action status"`
Expected: FAIL - `setActionStatus is not a function`

- [ ] **Step 3: Implement**

In `store/fleet.ts`, add the `protected` field to `ClusterDTO` (after `group`). It is **optional** - the Go DTO always emits it, but the many existing test fixtures predate it and a falsy default (no lock) is correct:

```ts
  protected?: boolean;
```

Add `suspended` to `ResourceDetailDTO` (after `name`), also optional (falsy default → "Suspend" label):

```ts
  suspended?: boolean;
```

Add an action-status type above `FleetState`:

```ts
export type ActionStatus = { kind: "success" | "error"; message: string };
```

Add to the `FleetState` type:

```ts
  actionStatus: ActionStatus | null;
  setActionStatus: (s: ActionStatus) => void;
  clearActionStatus: () => void;
```

Add to the store body (inside `create<FleetState>((set) => ({ ... }))`):

```ts
  actionStatus: null,
  setActionStatus: (actionStatus) => set({ actionStatus }),
  clearActionStatus: () => set({ actionStatus: null }),
```

Both new DTO fields are optional, so the existing `ClusterDTO`/`ResourceDetailDTO` literals across the test suite need no changes - they keep compiling under `tsc`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "action status"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts
git commit -m "feat(ui): store types for protected/suspended + action-status slice"
```

---

## Task 8: Frontend bridge - `reconcile` / `setSuspend`

**Files:**
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts`

- [ ] **Step 1: Add the bridge functions**

Append to `cmd/klyx/frontend/src/bridge/gitops.ts`:

```ts
type ActionResultDTO = { ok: boolean; error: string };

export async function reconcile(cluster: string, kind: string, namespace: string, name: string): Promise<void> {
  const r = (await GitOpsService.Reconcile(cluster, kind, namespace, name)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok ? { kind: "success", message: `Reconcile requested for ${namespace}/${name}` }
         : { kind: "error", message: r.error || "Reconcile failed" },
  );
}

export async function setSuspend(cluster: string, kind: string, namespace: string, name: string, suspend: boolean): Promise<void> {
  const r = (await GitOpsService.SetSuspend(cluster, kind, namespace, name, suspend)) as ActionResultDTO;
  useFleet.getState().setActionStatus(
    r.ok ? { kind: "success", message: `${suspend ? "Suspended" : "Resumed"} ${namespace}/${name}` }
         : { kind: "error", message: r.error || "Action failed" },
  );
}
```

NOTE: `GitOpsService.Reconcile` / `.SetSuspend` exist only after the Wails bindings are regenerated (Task 12). TypeScript will not typecheck this until then; that is expected. Do NOT run `npm run build` here - the vitest tests in later tasks mock this module, so they pass without the binding. The full build is Task 12.

- [ ] **Step 2: Commit**

```bash
git add cmd/klyx/frontend/src/bridge/gitops.ts
git commit -m "feat(ui): reconcile/setSuspend bridge fns with action-status toast"
```

---

## Task 9: `ConfirmDialog` component

**Files:**
- Create: `cmd/klyx/frontend/src/chrome/ConfirmDialog.tsx`
- Test: `cmd/klyx/frontend/src/chrome/ConfirmDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

This project's vitest has NO jest-dom setup (no `toBeDisabled`/`toBeInTheDocument`). Use plain matchers and read `.disabled` directly, matching the existing test style:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("non-protected: confirm enabled immediately and fires onConfirm", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <ConfirmDialog title="Reconcile" cluster="dev-ne" detail="Kustomization flux-system/app" protected={false} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const btn = getByText("Confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("protected: confirm disabled until the cluster name is typed", () => {
    const onConfirm = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <ConfirmDialog title="Suspend" cluster="prd-we" detail="Kustomization flux-system/app" protected={true} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const btn = getByText("Confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(getByPlaceholderText("prd-we"), { target: { value: "prd-we" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel fires onCancel", () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      <ConfirmDialog title="Reconcile" cluster="dev-ne" detail="x" protected={false} onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

(The default `confirmLabel` is `"Confirm"`, so `getByText("Confirm")` resolves the confirm button in these tests, which pass no `confirmLabel`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/chrome/ConfirmDialog.test.tsx`
Expected: FAIL - cannot find module `./ConfirmDialog`

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";

export function ConfirmDialog({
  title,
  cluster,
  detail,
  protected: isProtected,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  cluster: string;
  detail: string;
  protected: boolean;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = !isProtected || typed === cluster;

  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: 20, width: 380, fontSize: 13 }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ color: "var(--color-text-secondary)", marginBottom: 6 }}>{detail}</div>
        <div style={{ color: "var(--color-text-tertiary)", fontSize: 12, marginBottom: 14 }}>
          on <span style={{ fontFamily: "var(--font-mono)" }}>{cluster}</span>
        </div>
        {isProtected && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: "var(--color-text-warning)", fontSize: 12, marginBottom: 6 }}>
              Protected cluster. Type <b>{cluster}</b> to confirm.
            </div>
            <input
              autoFocus
              placeholder={cluster}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
            />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnStyle(false, false)}>Cancel</button>
          <button onClick={onConfirm} disabled={!armed} style={btnStyle(true, danger, !armed)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(primary: boolean, danger: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: 12,
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    border: "0.5px solid var(--color-border-tertiary)",
    background: primary ? (danger ? "var(--color-text-danger)" : "var(--color-background-accent, var(--color-background-secondary))") : "transparent",
    color: primary && danger ? "#fff" : "var(--color-text-primary)",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/chrome/ConfirmDialog.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/chrome/ConfirmDialog.tsx cmd/klyx/frontend/src/chrome/ConfirmDialog.test.tsx
git commit -m "feat(ui): ConfirmDialog with protected-cluster name gating"
```

---

## Task 10: Wire actions into the GitOps detail panel + toast + suspended badge

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Test: `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`

- [ ] **Step 1: Extend the bridge mock, then write the failing tests**

The new DTO fields are optional, so no existing literal needs changing. Two harness edits:

(a) Extend the existing `vi.mock("../bridge/gitops", ...)` factory to expose the two new fns as spies, and import them:

```tsx
import { reconcile, setSuspend } from "../bridge/gitops";

vi.mock("../bridge/gitops", () => ({
  openGitOps: async () => () => {},
  closeGitOps: async () => {},
  getResourceDetail: async () => {},
  reconcile: vi.fn(),
  setSuspend: vi.fn(),
}));
```

(b) Add `fireEvent` to the testing-library import: `import { render, fireEvent } from "@testing-library/react";` (`vi` is already imported from vitest).

Now add the new tests:

```tsx
const expandedDetail = (over: Partial<import("../store/fleet").ResourceDetailDTO> = {}) => ({
  cluster: "x",
  resources: [res({ kind: "Kustomization", namespace: "flux-system", name: "flux-system" })],
  loading: false,
  expandedKey: "Kustomization/flux-system/flux-system",
  detail: {
    kind: "Kustomization", namespace: "flux-system", name: "flux-system",
    suspended: false, appliedRevision: "main@a", attemptedRevision: "main@a", applyFailed: false,
    conditions: [], inventory: [], ...over,
  },
});

it("reconcile flows through the confirm dialog on a non-protected cluster", () => {
  useFleet.setState({ clusters: [cluster("Healthy", false)], gitops: expandedDetail() });
  const { getByText, getAllByRole } = render(<GitOps cluster="x" />);
  fireEvent.click(getByText("Reconcile"));               // panel button opens the dialog
  // Two buttons now read "Reconcile" (panel + dialog confirm); the dialog renders
  // after the table in DOM order, so the confirm button is the last match.
  const reconcileButtons = getAllByRole("button", { name: "Reconcile" });
  fireEvent.click(reconcileButtons[reconcileButtons.length - 1]);
  expect(reconcile).toHaveBeenCalledWith("x", "Kustomization", "flux-system", "flux-system");
});

it("shows Resume + a suspended badge when detail.suspended is true", () => {
  useFleet.setState({ clusters: [cluster("Healthy", false)], gitops: expandedDetail({ suspended: true }) });
  const { getByText, queryByText } = render(<GitOps cluster="x" />);
  expect(getByText("Resume")).toBeTruthy();
  expect(queryByText("Suspend")).toBeNull();
});

it("renders the action-status toast", () => {
  useFleet.setState({ clusters: [cluster("Healthy")], actionStatus: { kind: "success", message: "Reconcile requested for flux-system/x" } });
  const { getByText } = render(<GitOps cluster="x" />);
  expect(getByText(/Reconcile requested/i)).toBeTruthy();
});
```

(The first test relies on the `ConfirmDialog` confirm button label being `Reconcile` for the reconcile verb, matching Task 10's wiring. `getByText("Reconcile")` finds the panel action button; after the dialog opens, `getByRole("button", { name: "Reconcile" })` resolves the dialog's confirm button - both are buttons reading "Reconcile", so assert the mock call rather than element identity.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/GitOps.test.tsx`
Expected: FAIL - no Reconcile button found

- [ ] **Step 3: Implement the actions row + toast**

In `GitOps.tsx`:

1. Add imports:

```tsx
import { useState } from "react";
import { openGitOps, closeGitOps, getResourceDetail, reconcile, setSuspend } from "../bridge/gitops";
import { ConfirmDialog } from "../chrome/ConfirmDialog";
```

2. In the `GitOps` component, read the protected flag, action status, and hold pending-action state:

```tsx
  const isProtected = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.protected ?? false);
  const actionStatus = useFleet((s) => s.actionStatus);
  const clearActionStatus = useFleet((s) => s.clearActionStatus);
  const [pending, setPending] = useState<null | { verb: "reconcile" | "suspend" | "resume"; r: FluxResourceDTO }>(null);
```

3. Render a toast above the table (inside the outer `<div style={{ padding: "14px 16px" }}>`, right after the summary counts block):

```tsx
      {actionStatus && (
        <div
          onClick={clearActionStatus}
          style={{ marginBottom: 10, padding: "6px 10px", fontSize: 12, borderRadius: 4, cursor: "pointer",
            background: "var(--color-background-secondary)",
            color: actionStatus.kind === "error" ? "var(--color-text-danger)" : "var(--color-text-success)",
            border: "0.5px solid var(--color-border-tertiary)" }}
        >
          {actionStatus.message}
        </div>
      )}
```

4. Pass an `onAction` callback down to `DetailPanel`, and render the dialog when `pending` is set. Change the expanded-row render to:

```tsx
                {open && (
                  <DetailPanel
                    resource={r}
                    detail={gitops.detail && keyOf(gitops.detail) === k ? gitops.detail : null}
                    onReconcile={() => setPending({ verb: "reconcile", r })}
                    onToggleSuspend={(suspended) => setPending({ verb: suspended ? "resume" : "suspend", r })}
                  />
                )}
```

5. After the table `</div>`, before the component's closing `</div>`, render the dialog:

```tsx
      {pending && (
        <ConfirmDialog
          title={pending.verb === "reconcile" ? "Reconcile" : pending.verb === "suspend" ? "Suspend reconciliation" : "Resume reconciliation"}
          cluster={cluster}
          detail={`${pending.r.kind} ${pending.r.namespace}/${pending.r.name}`}
          protected={isProtected}
          danger={pending.verb === "suspend"}
          confirmLabel={pending.verb === "reconcile" ? "Reconcile" : pending.verb === "suspend" ? "Suspend" : "Resume"}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { verb, r } = pending;
            setPending(null);
            if (verb === "reconcile") void reconcile(cluster, r.kind, r.namespace, r.name);
            else void setSuspend(cluster, r.kind, r.namespace, r.name, verb === "suspend");
          }}
        />
      )}
```

6. Update `DetailPanel`'s signature and add the actions row + suspended badge. Change its props and prepend the actions:

```tsx
function DetailPanel({ resource, detail, onReconcile, onToggleSuspend }: {
  resource: FluxResourceDTO;
  detail: ResourceDetailDTO | null;
  onReconcile: () => void;
  onToggleSuspend: (suspended: boolean) => void;
}) {
  if (!detail) {
    return <div style={{ padding: "6px 12px 12px 38px", fontSize: 12, color: "var(--color-text-secondary)" }}>Loading detail…</div>;
  }
  const condColor = (c: { status: string }) => (c.status === "True" ? "var(--color-text-success)" : c.status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)");
  return (
    <div style={{ padding: "6px 12px 14px 38px", background: "var(--color-background-secondary)", fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button onClick={onReconcile} style={actionBtn}>Reconcile</button>
        <button onClick={() => onToggleSuspend(detail.suspended)} style={actionBtn}>
          {detail.suspended ? "Resume" : "Suspend"}
        </button>
        {detail.suspended && (
          <span style={{ color: "var(--color-text-warning)", fontSize: 11, fontWeight: 500 }}>suspended</span>
        )}
      </div>
      {detail.applyFailed && (
        <div style={{ color: "var(--color-text-danger)", marginBottom: 8 }}>apply failed at <span style={{ fontFamily: "var(--font-mono)" }}>{shortRev(detail.attemptedRevision)}</span></div>
      )}
      {/* ...existing Conditions + Inventory sections unchanged... */}
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)",
};
```

Keep the existing Conditions and Inventory JSX exactly as it was, just below the new actions row.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/GitOps.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/GitOps.tsx cmd/klyx/frontend/src/cluster/GitOps.test.tsx
git commit -m "feat(ui): reconcile/suspend actions row + confirm dialog + toast in GitOps panel"
```

---

## Task 11: Protected-lock affordance on the cluster card

**Files:**
- Modify: `cmd/klyx/frontend/src/fleet/ClusterCard.tsx`
- Test: `cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

`protected` is optional, so the existing `base` literal needs no change. Add two tests that spread `base` with an explicit `protected`, using `queryByTitle` from the render result (this file destructures queries, it does not use `screen`):

```tsx
it("shows a lock affordance for a protected cluster", () => {
  const { queryByTitle } = render(<ClusterCard c={{ ...base, protected: true }} />);
  expect(queryByTitle("protected")).toBeTruthy();
});

it("has no lock for an unprotected cluster", () => {
  const { queryByTitle } = render(<ClusterCard c={{ ...base, protected: false }} />);
  expect(queryByTitle("protected")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/ClusterCard.test.tsx`
Expected: FAIL - no element with title "protected"

- [ ] **Step 3: Implement**

In `ClusterCard.tsx`, in the header row (the `div` with the state dot + name), append a lock after the name:

```tsx
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor[c.state] ?? "var(--color-text-tertiary)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 12 }}>{c.name}</span>
        {c.protected && (
          <span title="protected" style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-warning)" }}>🔒</span>
        )}
      </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/ClusterCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/fleet/ClusterCard.tsx cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx
git commit -m "feat(ui): protected-cluster lock affordance on the fleet card"
```

---

## Task 12: Regenerate bindings, full build, and verification

**Files:**
- Regenerated: `cmd/klyx/frontend/bindings/**` (generated, gitignored)
- No source changes expected unless the build surfaces a typing gap.

- [ ] **Step 1: Regenerate Wails bindings + full Go suite**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test
go test -race ./internal/...
make vet
```
Expected: all PASS.

- [ ] **Step 2: Frontend suite + production build (regenerates bindings)**

```bash
cd cmd/klyx/frontend && npx vitest run
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: vitest all green; `wails3 build` exits 0. The build regenerates `bindings/` so `GitOpsService.Reconcile` / `.SetSuspend` exist and `bridge/gitops.ts` typechecks. If `tsc` errors that those methods are missing, run `PATH="$HOME/go/bin:$PATH" wails3 generate bindings` first, then rebuild.

- [ ] **Step 3: Native handoff (manual, owner)**

On `homelab-nelli`: open a Kustomization, click Reconcile, confirm, and watch the `lastApplied` age reset on the next tick. Suspend it, see the badge + row label flip to `suspended`, then Resume. Tag a cluster `protected: true` in the fleet config and confirm the dialog requires typing the name. Confirm a read-only kubeconfig surfaces the 403 in the toast.

- [ ] **Step 4: Commit any build-surfaced fixes**

```bash
git add -A
git commit -m "chore(m3c-i): verification fixes after binding regen"
```
(Skip if nothing changed.)

---

## Self-review notes

- **Spec coverage:** §2 guardrail → Tasks 6, 9, 10, 11. §3 config → Task 6. §4.1 patch cores → Task 1. §4.2 Suspended → Tasks 2, 3. §4.3 ClusterConn writes → Task 4. §6 appbridge actions → Task 5. §7 frontend (actions row, confirm dialog, suspended badge, env chip, bridge, store) → Tasks 7-11. CLAUDE.md edit → already committed before this plan. View-in-git (§5) is intentionally NOT here - it is M3-c-ii.
- **Env field reuse:** `Environment` config feeds the existing `env` DTO/badge (preferred over `tags["env"]`); only `protected` is a new DTO field. Documented in Task 6.
- **Binding timing:** `bridge/gitops.ts` references not-yet-generated methods until Task 12's build; vitest mocks the bridge so unit tests are unaffected. Called out in Tasks 8 and 12.
- **Optional TS fields:** `protected` and `suspended` are required on the Go DTOs (always emitted) but OPTIONAL (`?`) on the TS types. Eight existing test files construct `ClusterDTO`/`ResourceDetailDTO` literals; making the TS fields optional keeps every one compiling under `tsc` with a correct falsy default (no lock / "Suspend" label), avoiding scattered fixups. Decided during self-review after grepping the literals.
- **Type consistency:** `ActionResultDTO {ok,error}` (Go) ↔ `{ok,error}` (TS bridge). `ResourceDetailDTO.suspended` added in Task 3 (Go) and Task 7 (TS). `ClusterDTO.protected` added in Task 6 (Go) and Task 7 (TS). `Conn`/`GitOpsConn` gain identical `Reconcile`/`SetSuspend` signatures in Tasks 4 and 5; fakes updated in the same tasks. `ConfirmDialog` props in Task 9 match the call site in Task 10. The bridge `reconcile`/`setSuspend` (Task 8) match the mock spies and call sites in Task 10.
```
