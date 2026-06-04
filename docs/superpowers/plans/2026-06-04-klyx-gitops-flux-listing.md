# Klyx GitOps M3-a Implementation Plan (Flux reconciliation listing)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the GitOps placeholder into a live, read-only Flux reconciliation list (Kustomizations + HelmReleases with status/revision/last-applied), fed by a new lazy per-cluster drilldown watch.

**Architecture:** A pure `internal/gitops/flux` package parses unstructured Flux CRDs into vocabulary-correct `Resource`s. `ClusterConn` gains a lazy `OpenGitOps/CloseGitOps/GitOpsResources` dynamic-informer watch (the reusable drilldown pattern). `appbridge.GitOpsService` (sample-and-push, like FleetService) exposes `Open/Close` and emits `gitops:updated{cluster,resources}`. The React GitOps view opens the watch on mount and renders the table.

**Tech Stack:** Go + client-go (`dynamic`, `dynamicinformer`, `discovery`, `unstructured`); React + TS + Zustand. Frontend root: `cmd/klyx/frontend/`. Wails event API: `app.Event.Emit` / `Events.On` (pinned in the Wails B-1 slice).

**Spec:** `docs/superpowers/specs/2026-06-04-klyx-gitops-flux-listing-design.md`

**Out of scope (later):** drift diff (M3-b), reconcile/suspend/view-in-git (M3-c), Argo/coexistence (M6).

---

### Task 1: `internal/gitops/flux` - types + parsers

Pure: unstructured Flux CRDs → vocabulary-correct `Resource`. No Flux Go dependency.

**Files:**
- Create: `internal/gitops/flux/flux.go`
- Test: `internal/gitops/flux/flux_test.go`

- [ ] **Step 1: Write the failing test**

`internal/gitops/flux/flux_test.go`:
```go
package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ks(status string, reason string, suspend bool, rev, msg string) *unstructured.Unstructured {
	conds := []interface{}{
		map[string]interface{}{"type": "Ready", "status": status, "reason": reason, "message": msg},
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"spec":       map[string]interface{}{"suspend": suspend},
		"status": map[string]interface{}{
			"conditions":          conds,
			"lastAppliedRevision": rev,
		},
	}}
}

func TestParseKustomizationReady(t *testing.T) {
	r := ParseKustomization(ks("True", "ReconciliationSucceeded", false, "main@sha1:abc1234", ""))
	if r.Kind != KustomizationKind {
		t.Fatalf("kind: %q", r.Kind)
	}
	if r.Name != "flux-system" || r.Namespace != "flux-system" {
		t.Fatalf("name/ns: %+v", r)
	}
	if r.Ready != Ready {
		t.Fatalf("ready: %q", r.Ready)
	}
	if r.Revision != "main@sha1:abc1234" {
		t.Fatalf("revision: %q", r.Revision)
	}
	if r.Suspended {
		t.Fatalf("should not be suspended")
	}
}

func TestParseKustomizationFailedAndSuspended(t *testing.T) {
	r := ParseKustomization(ks("False", "BuildFailed", true, "", "kustomize build failed"))
	if r.Ready != Failed {
		t.Fatalf("want Failed, got %q", r.Ready)
	}
	if r.Message != "kustomize build failed" {
		t.Fatalf("message: %q", r.Message)
	}
	if !r.Suspended {
		t.Fatalf("want suspended")
	}
}

func TestParseKustomizationReconciling(t *testing.T) {
	u := ks("Unknown", "Progressing", false, "", "reconciliation in progress")
	// add a Reconciling condition
	conds := u.Object["status"].(map[string]interface{})["conditions"].([]interface{})
	conds = append(conds, map[string]interface{}{"type": "Reconciling", "status": "True"})
	u.Object["status"].(map[string]interface{})["conditions"] = conds
	r := ParseKustomization(u)
	if r.Ready != Reconciling {
		t.Fatalf("want Reconciling, got %q", r.Ready)
	}
}

func TestParseHelmReleaseReadyRevisionFromHistory(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2",
		"kind":       "HelmRelease",
		"metadata":   map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"spec":       map[string]interface{}{},
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "message": "Helm install succeeded"},
			},
			"history": []interface{}{
				map[string]interface{}{"chartVersion": "1.16.5"},
			},
		},
	}}
	r := ParseHelmRelease(u)
	if r.Kind != HelmReleaseKind || r.Name != "cilium" {
		t.Fatalf("identity: %+v", r)
	}
	if r.Ready != Ready {
		t.Fatalf("ready: %q", r.Ready)
	}
	if r.Revision != "1.16.5" {
		t.Fatalf("revision: %q", r.Revision)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/gitops/flux/ -v`
Expected: FAIL - undefined `ParseKustomization`, etc.

- [ ] **Step 3: Implement `internal/gitops/flux/flux.go`**

```go
// Package flux parses Flux CRDs (read as unstructured) into vocabulary-correct
// reconciliation resources. No Flux Go API dependency: tolerant of version drift.
package flux

import (
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type Kind string

const (
	KustomizationKind Kind = "Kustomization"
	HelmReleaseKind   Kind = "HelmRelease"
)

type ReadyState string

const (
	Ready       ReadyState = "Ready"
	Reconciling ReadyState = "Reconciling"
	Failed      ReadyState = "Failed"
	Unknown     ReadyState = "Unknown"
)

// Resource is a Flux-managed object's reconciliation state.
type Resource struct {
	Kind        Kind
	Namespace   string
	Name        string
	Ready       ReadyState
	Message     string
	Revision    string
	LastApplied time.Time
	Suspended   bool
}

func ParseKustomization(u *unstructured.Unstructured) Resource {
	r := common(u, KustomizationKind)
	r.Revision, _, _ = unstructured.NestedString(u.Object, "status", "lastAppliedRevision")
	return r
}

func ParseHelmRelease(u *unstructured.Unstructured) Resource {
	r := common(u, HelmReleaseKind)
	// Prefer status.lastAppliedRevision; else the last history entry's chartVersion.
	if rev, ok, _ := unstructured.NestedString(u.Object, "status", "lastAppliedRevision"); ok && rev != "" {
		r.Revision = rev
	} else if hist, ok, _ := unstructured.NestedSlice(u.Object, "status", "history"); ok && len(hist) > 0 {
		if last, ok := hist[len(hist)-1].(map[string]interface{}); ok {
			if cv, ok := last["chartVersion"].(string); ok {
				r.Revision = cv
			}
		}
	}
	return r
}

func common(u *unstructured.Unstructured, kind Kind) Resource {
	r := Resource{Kind: kind, Name: u.GetName(), Namespace: u.GetNamespace()}
	if susp, ok, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); ok {
		r.Suspended = susp
	}
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	reconciling := false
	r.Ready = Unknown
	for _, c := range conds {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		ctype, _ := cm["type"].(string)
		cstatus, _ := cm["status"].(string)
		switch ctype {
		case "Ready":
			switch cstatus {
			case "True":
				r.Ready = Ready
			case "False":
				r.Ready = Failed
			}
			if msg, ok := cm["message"].(string); ok {
				r.Message = msg
			}
			if lt, ok := cm["lastTransitionTime"].(string); ok {
				if t, err := time.Parse(time.RFC3339, lt); err == nil {
					r.LastApplied = t
				}
			}
		case "Reconciling":
			if cstatus == "True" {
				reconciling = true
			}
		}
	}
	if reconciling && r.Ready != Failed {
		r.Ready = Reconciling
	}
	return r
}

var _ = metav1.Now // keep metav1 import available for future condition helpers
```
(Remove the trailing `var _ = metav1.Now` line and the `metav1` import if `go vet`/build flags it as unused; it is a guard only.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/gitops/flux/ -v`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add internal/gitops/flux/
git commit -m "$(printf 'feat: flux package - parse Kustomization/HelmRelease from unstructured\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Lazy per-cluster GitOps watch on `ClusterConn`

The reusable drilldown pattern: dynamic informers on the Flux GVRs, started on open, stopped on close. Extends the `Conn` interface and `Registry`.

**Files:**
- Modify: `internal/fleet/conn.go` (add `ctx`, `dyn`, gitops fields; extend `Conn` interface)
- Create: `internal/fleet/gitopswatch.go`
- Modify: `internal/fleet/factory.go` (build a dynamic client)
- Modify: `internal/fleet/registry.go` (add `Conn(name)`)
- Modify: `internal/fleet/registry_test.go` (fakeConn stubs for the new interface methods)
- Test: `internal/fleet/gitopswatch_test.go`

- [ ] **Step 1: Extend the `Conn` interface and store ctx + dynamic client**

In `internal/fleet/conn.go`:
a) Extend the interface:
```go
type Conn interface {
	Name() string
	Start(ctx context.Context)
	Snapshot() Snapshot
	OpenGitOps()
	CloseGitOps()
	GitOpsResources() []flux.Resource
}
```
b) Add to the `ClusterConn` struct fields:
```go
	dyn dynamic.Interface
	ctx context.Context // captured in Start, used to scope lazy watches

	gitops *gitopsWatch // lazy; nil until OpenGitOps
```
c) Add imports: `"k8s.io/client-go/dynamic"` and `"github.com/moomora/klyx/internal/gitops/flux"`.
d) Add a `dyn` parameter to `NewClusterConn` and store it; capture `ctx` at the top of `Start`:
```go
func NewClusterConn(name string, typed kubernetes.Interface, meta metadata.Interface,
	dyn dynamic.Interface, detector *capability.Detector, clk clock.Clock) *ClusterConn {
	return &ClusterConn{
		name: name, typed: typed, meta: meta, dyn: dyn, detector: detector, clk: clk,
		state:          Unconnected,
		connectTimeout: defaultConnectTimeout,
		refresh:        make(chan struct{}, 1),
	}
}
```
In `Start`, add as the first line after `c.setState(EvStart, "")`:
```go
	c.ctx = ctx
```

- [ ] **Step 2: Update `NewClusterConn` callers**

- `internal/fleet/factory.go` `DefaultConnFactory`: build a dynamic client and pass it:
  ```go
  import "k8s.io/client-go/dynamic"
  // ...
  dyn, err := dynamic.NewForConfig(rc)
  if err != nil {
  	return nil, fmt.Errorf("dynamic client for %q: %w", cc.Name, err)
  }
  det := capability.NewDetector(typed)
  return NewClusterConn(cc.Name, typed, mclient, dyn, det, clk), nil
  ```
- Any existing `NewClusterConn(...)` calls in tests (`conn_test.go`, `caphealth_test.go`) gain a `nil` dynamic arg: `NewClusterConn("x", typed, mclient, nil, det, clock.Real{})`. Update each call site (the gitops watch is not exercised by those tests, so `nil` is fine there).

- [ ] **Step 3: Add `Registry.Conn` + fakeConn stubs**

In `internal/fleet/registry.go`, add:
```go
// Conn returns the live Conn for a cluster by name (nil,false if absent or failed).
func (r *Registry) Conn(name string) (Conn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, e := range r.entries {
		if e.failed || e.conn == nil {
			continue
		}
		if e.conn.Name() == name {
			return e.conn, true
		}
	}
	return nil, false
}
```
In `internal/fleet/registry_test.go`, add stubs to `fakeConn` so it still satisfies `Conn`:
```go
func (f *fakeConn) OpenGitOps()                      {}
func (f *fakeConn) CloseGitOps()                     {}
func (f *fakeConn) GitOpsResources() []flux.Resource { return nil }
```
(Add the import `"github.com/moomora/klyx/internal/gitops/flux"` to the test file.)

- [ ] **Step 4: Write the failing gitops-watch test**

`internal/fleet/gitopswatch_test.go`:
```go
package fleet

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/gitops/flux"
)

func ksObj(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1",
		"kind":       "Kustomization",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"status": map[string]interface{}{
			"conditions":          []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
			"lastAppliedRevision": "main@sha1:abc",
		},
	}}
}

func TestOpenGitOpsListsKustomizations(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Discovery: advertise the Flux groups so version resolution finds v1.
	typed := fake.NewSimpleClientset()
	// (FakeDiscovery has no groups by default; the watch falls back to v1, see impl.)

	scheme := runtime.NewScheme()
	ksGVR := schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	gvrToListKind := map[schema.GroupVersionResource]string{
		ksGVR: "KustomizationList",
		{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}: "HelmReleaseList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToListKind, ksObj("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{})
	c.ctx = ctx // Start not called in this unit; set ctx directly

	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		rs := c.GitOpsResources()
		return len(rs) == 1 && rs[0].Kind == flux.KustomizationKind && rs[0].Ready == flux.Ready
	})
}

var _ = metav1.Now
```

- [ ] **Step 5: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestOpenGitOpsLists -v`
Expected: FAIL - `OpenGitOps`/`gitopsWatch` undefined.

- [ ] **Step 6: Implement `internal/fleet/gitopswatch.go`**

```go
package fleet

import (
	"context"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"

	"github.com/moomora/klyx/internal/gitops/flux"
)

type gitopsWatch struct {
	cancel    context.CancelFunc
	ksInf     cache.SharedIndexInformer
	hrInf     cache.SharedIndexInformer
}

// preferredVersion returns the served preferred version for a CRD group, or
// fallback if the group is not advertised (the fake discovery in tests has no
// groups, so the fallback is used there).
func preferredVersion(disc discovery.DiscoveryInterface, group, fallback string) string {
	groups, err := disc.ServerGroups()
	if err != nil || groups == nil {
		return fallback
	}
	for _, g := range groups.Groups {
		if g.Name == group {
			if g.PreferredVersion.Version != "" {
				return g.PreferredVersion.Version
			}
			if len(g.Versions) > 0 {
				return g.Versions[0].Version
			}
		}
	}
	return fallback
}

// OpenGitOps starts (idempotently) the lazy dynamic informers on the Flux CRDs.
func (c *ClusterConn) OpenGitOps() {
	c.mu.Lock()
	if c.gitops != nil {
		c.mu.Unlock()
		return // already open
	}
	dyn := c.dyn
	parent := c.ctx
	c.mu.Unlock()
	if dyn == nil || parent == nil {
		return
	}

	ksVer := preferredVersion(c.typed.Discovery(), "kustomize.toolkit.fluxcd.io", "v1")
	hrVer := preferredVersion(c.typed.Discovery(), "helm.toolkit.fluxcd.io", "v2")
	ksGVR := schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: ksVer, Resource: "kustomizations"}
	hrGVR := schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: hrVer, Resource: "helmreleases"}

	gctx, cancel := context.WithCancel(parent)
	factory := dynamicinformer.NewDynamicSharedInformerFactory(dyn, defaultResync)
	ksInf := factory.ForResource(ksGVR).Informer()
	hrInf := factory.ForResource(hrGVR).Informer()
	factory.Start(gctx.Done())

	c.mu.Lock()
	c.gitops = &gitopsWatch{cancel: cancel, ksInf: ksInf, hrInf: hrInf}
	c.mu.Unlock()
}

// CloseGitOps stops the Flux informers after a short grace period.
func (c *ClusterConn) CloseGitOps() {
	c.mu.Lock()
	g := c.gitops
	c.gitops = nil
	c.mu.Unlock()
	if g != nil {
		g.cancel()
	}
}

// GitOpsResources reads the informer stores and parses them into Flux resources.
// Returns nil when the watch is not open.
func (c *ClusterConn) GitOpsResources() []flux.Resource {
	c.mu.RLock()
	g := c.gitops
	c.mu.RUnlock()
	if g == nil {
		return nil
	}
	var out []flux.Resource
	for _, obj := range g.ksInf.GetStore().List() {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			out = append(out, flux.ParseKustomization(u))
		}
	}
	for _, obj := range g.hrInf.GetStore().List() {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			out = append(out, flux.ParseHelmRelease(u))
		}
	}
	return out
}

var _ = sync.Mutex{}
var _ = time.Second
```
(Remove the two trailing `var _ =` guards if the build flags them; `sync`/`time` are only needed if referenced - drop the imports if unused.)

- [ ] **Step 7: Run tests + race**

Run: `go test ./internal/fleet/ -run 'TestOpenGitOpsLists|TestRegistry|TestClusterConn' -v` then `go test -race ./internal/fleet/`
Expected: PASS, no race. If the dynamic-fake list/watch wiring differs in the pinned client-go (e.g. `NewSimpleDynamicClientWithCustomListKinds` signature), adapt to the package's constructor that registers the two GVR list kinds and delivers them to informers; the goal is `GitOpsResources()` reflecting the seeded Kustomization.

- [ ] **Step 8: Run the whole package + vet, then commit**

Run: `go test ./internal/fleet/ && go vet ./internal/fleet/`
```bash
git add internal/fleet/conn.go internal/fleet/gitopswatch.go internal/fleet/factory.go internal/fleet/registry.go internal/fleet/registry_test.go internal/fleet/conn_test.go internal/fleet/caphealth_test.go internal/fleet/gitopswatch_test.go
git commit -m "$(printf 'feat: lazy per-cluster GitOps dynamic-informer watch on ClusterConn\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `appbridge` FluxResourceDTO + projection

**Files:**
- Create: `internal/appbridge/gitops_dto.go`
- Test: `internal/appbridge/gitops_dto_test.go`

- [ ] **Step 1: Write the failing test**

`internal/appbridge/gitops_dto_test.go`:
```go
package appbridge

import (
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToFluxDTO(t *testing.T) {
	now := time.Date(2026, 6, 4, 12, 0, 30, 0, time.UTC)
	r := flux.Resource{
		Kind: flux.KustomizationKind, Namespace: "flux-system", Name: "flux-system",
		Ready: flux.Ready, Message: "", Revision: "main@sha1:abc",
		LastApplied: now.Add(-30 * time.Second), Suspended: false,
	}
	d := ToFluxDTO(r, now)
	if d.Kind != "Kustomization" || d.Name != "flux-system" || d.Namespace != "flux-system" {
		t.Fatalf("identity: %+v", d)
	}
	if d.Ready != "Ready" || d.Revision != "main@sha1:abc" {
		t.Fatalf("fields: %+v", d)
	}
	if d.LastAppliedAgeSeconds != 30 {
		t.Fatalf("age: %d", d.LastAppliedAgeSeconds)
	}
}

func TestToFluxDTOZeroTimeAge(t *testing.T) {
	now := time.Now()
	d := ToFluxDTO(flux.Resource{Kind: flux.HelmReleaseKind, Name: "x", Ready: flux.Failed}, now)
	if d.LastAppliedAgeSeconds != 0 {
		t.Fatalf("want 0 age for zero time, got %d", d.LastAppliedAgeSeconds)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestToFluxDTO -v`
Expected: FAIL - undefined `ToFluxDTO`.

- [ ] **Step 3: Implement `internal/appbridge/gitops_dto.go`**

```go
package appbridge

import (
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// FluxResourceDTO is the JSON projection of a Flux reconciliation resource.
type FluxResourceDTO struct {
	Kind                  string `json:"kind"`
	Namespace             string `json:"namespace"`
	Name                  string `json:"name"`
	Ready                 string `json:"ready"`
	Message               string `json:"message"`
	Revision              string `json:"revision"`
	LastAppliedAgeSeconds int64  `json:"lastAppliedAgeSeconds"`
	Suspended             bool   `json:"suspended"`
}

func ToFluxDTO(r flux.Resource, now time.Time) FluxResourceDTO {
	age := int64(0)
	if !r.LastApplied.IsZero() {
		age = int64(now.Sub(r.LastApplied).Seconds())
		if age < 0 {
			age = 0
		}
	}
	return FluxResourceDTO{
		Kind:                  string(r.Kind),
		Namespace:             r.Namespace,
		Name:                  r.Name,
		Ready:                 string(r.Ready),
		Message:               r.Message,
		Revision:              r.Revision,
		LastAppliedAgeSeconds: age,
		Suspended:             r.Suspended,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/appbridge/ -run TestToFluxDTO -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_dto_test.go
git commit -m "$(printf 'feat: appbridge FluxResourceDTO projection\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: `appbridge` GitOpsService (Open/Close + sample-and-push)

**Files:**
- Create: `internal/appbridge/gitops_service.go`
- Test: `internal/appbridge/gitops_service_test.go`

- [ ] **Step 1: Write the failing test**

`internal/appbridge/gitops_service_test.go`:
```go
package appbridge

import (
	"sync"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

type fakeGitOpsConn struct {
	mu     sync.Mutex
	opened int
	closed int
	res    []flux.Resource
}

func (f *fakeGitOpsConn) OpenGitOps()  { f.mu.Lock(); f.opened++; f.mu.Unlock() }
func (f *fakeGitOpsConn) CloseGitOps() { f.mu.Lock(); f.closed++; f.mu.Unlock() }
func (f *fakeGitOpsConn) GitOpsResources() []flux.Resource {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.res
}

func TestGitOpsServiceOpenEmitsAndCloseStops(t *testing.T) {
	conn := &fakeGitOpsConn{res: []flux.Resource{
		{Kind: flux.KustomizationKind, Name: "flux-system", Ready: flux.Ready},
	}}
	lookup := func(name string) (GitOpsConn, bool) {
		if name == "x" {
			return conn, true
		}
		return nil, false
	}
	em := &fakeEmitter{}
	svc := NewGitOpsService(lookup, em, func() time.Time { return time.Now() }, 10*time.Millisecond)

	svc.Open("x")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		em.mu.Lock()
		n := em.events
		em.mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	em.mu.Lock()
	got := em.events
	em.mu.Unlock()
	if got < 1 {
		t.Fatal("expected at least one gitops:updated emit")
	}

	svc.Close("x")
	conn.mu.Lock()
	opened, closed := conn.opened, conn.closed
	conn.mu.Unlock()
	if opened != 1 || closed != 1 {
		t.Fatalf("want opened=1 closed=1, got %d/%d", opened, closed)
	}
}

func TestGitOpsServiceOpenUnknownClusterNoop(t *testing.T) {
	lookup := func(string) (GitOpsConn, bool) { return nil, false }
	svc := NewGitOpsService(lookup, &fakeEmitter{}, time.Now, time.Second)
	svc.Open("ghost") // must not panic
	svc.Close("ghost")
}
```
(`fakeEmitter` already exists in `service_test.go` in this package.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGitOpsService -v`
Expected: FAIL - undefined `NewGitOpsService`/`GitOpsConn`.

- [ ] **Step 3: Implement `internal/appbridge/gitops_service.go`**

```go
package appbridge

import (
	"context"
	"sync"
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// GitOpsConn is the per-cluster watch surface GitOpsService needs.
type GitOpsConn interface {
	OpenGitOps()
	CloseGitOps()
	GitOpsResources() []flux.Resource
}

// GitOpsUpdatedEvent is emitted with { cluster, resources }.
const GitOpsUpdatedEvent = "gitops:updated"

type gitOpsPayload struct {
	Cluster   string            `json:"cluster"`
	Resources []FluxResourceDTO `json:"resources"`
}

// GitOpsService is bound to JS. Open starts a cluster's lazy watch and pushes
// gitops:updated on a tick; Close stops it.
type GitOpsService struct {
	lookup   func(string) (GitOpsConn, bool)
	em       Emitter
	now      func() time.Time
	interval time.Duration

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewGitOpsService(lookup func(string) (GitOpsConn, bool), em Emitter, now func() time.Time, interval time.Duration) *GitOpsService {
	return &GitOpsService{lookup: lookup, em: em, now: now, interval: interval, cancels: map[string]context.CancelFunc{}}
}

func (s *GitOpsService) Open(cluster string) {
	conn, ok := s.lookup(cluster)
	if !ok {
		return
	}
	s.mu.Lock()
	if _, active := s.cancels[cluster]; active {
		s.mu.Unlock()
		return // idempotent
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancels[cluster] = cancel
	s.mu.Unlock()

	conn.OpenGitOps()
	go s.pushLoop(ctx, cluster, conn)
}

func (s *GitOpsService) Close(cluster string) {
	s.mu.Lock()
	cancel := s.cancels[cluster]
	delete(s.cancels, cluster)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if conn, ok := s.lookup(cluster); ok {
		conn.CloseGitOps()
	}
}

func (s *GitOpsService) pushLoop(ctx context.Context, cluster string, conn GitOpsConn) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := s.now()
			res := conn.GitOpsResources()
			dtos := make([]FluxResourceDTO, 0, len(res))
			for _, r := range res {
				dtos = append(dtos, ToFluxDTO(r, now))
			}
			s.em.Emit(GitOpsUpdatedEvent, gitOpsPayload{Cluster: cluster, Resources: dtos})
		}
	}
}
```

- [ ] **Step 4: Run tests + race**

Run: `go test ./internal/appbridge/ -race -v`
Expected: PASS (flux DTO + GitOpsService + existing fleet service tests), no race.

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gitops_service.go internal/appbridge/gitops_service_test.go
git commit -m "$(printf 'feat: appbridge GitOpsService open/close + gitops:updated push\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Wire GitOpsService into `main.go`

**Files:**
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Register the service + adapt the registry lookup**

In `cmd/klyx/main.go`, after constructing `svc` (FleetService) and before `application.New`, build the GitOps service and add it to the bound services. The registry's `Conn(name) (fleet.Conn, bool)` is adapted to `appbridge.GitOpsConn` via a closure (`fleet.Conn` already has the three GitOps methods):
```go
	gitopsSvc := appbridge.NewGitOpsService(
		func(name string) (appbridge.GitOpsConn, bool) {
			c, ok := reg.Conn(name)
			if !ok {
				return nil, false
			}
			return c, true
		},
		emitterAdapter{app: app}, // NOTE: app is created below; see step 2 ordering
		time.Now,
		time.Second,
	)
```
Then register both services:
```go
	app := application.New(application.Options{
		Name:     "Klyx",
		Services: []application.Service{
			application.NewService(svc),
			application.NewService(gitopsSvc),
		},
	})
```

- [ ] **Step 2: Fix construction ordering**

`gitopsSvc` needs the `app` (for the emitter), but `app` needs `gitopsSvc` in its `Services`. Resolve by creating the GitOpsService with a deferred emitter: construct `app` first with both services, but build `gitopsSvc` before `app` and set its emitter after. Simplest: give `GitOpsService` the emitter via the same `emitterAdapter` which only needs `app` at emit time. Reorder so `app` is created first, then `gitopsSvc`, then register is not possible (services are passed at New). Instead, construct `gitopsSvc` with a pointer-to-emitter that is filled after `app` exists:

Use a tiny indirection - an `emitterAdapter` whose `app` field is set after `New`:
```go
	em := &emitterAdapter{}
	fleetSvc := svc // existing FleetService
	gitopsSvc := appbridge.NewGitOpsService(
		func(name string) (appbridge.GitOpsConn, bool) {
			c, ok := reg.Conn(name); if !ok { return nil, false }; return c, true
		},
		em, time.Now, time.Second,
	)
	app := application.New(application.Options{
		Name: "Klyx",
		Services: []application.Service{
			application.NewService(fleetSvc),
			application.NewService(gitopsSvc),
		},
	})
	em.app = app
	go svc.Run(ctx, em, time.Second)
```
Change `emitterAdapter` to a pointer receiver with a settable `app`:
```go
type emitterAdapter struct{ app *application.App }
func (e *emitterAdapter) Emit(name string, data any) { e.app.Event.Emit(name, data) }
```
(Update the existing `go svc.Run(ctx, emitterAdapter{app: app}, ...)` call to use the shared `em` pointer as shown.)

- [ ] **Step 2b: Build**

Run: `cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build 2>&1 | tail -15` (or `go build ./cmd/klyx` if only checking Go compilation; note `make build` excludes the wails build dirs).
Expected: builds; the GitOpsService binding is generated under `cmd/klyx/frontend/bindings/.../appbridge/`.

- [ ] **Step 3: Commit**

```bash
git add cmd/klyx/main.go
git commit -m "$(printf 'feat: register GitOpsService in the Wails app\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Frontend store slice + gitops bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Create: `cmd/klyx/frontend/src/bridge/gitops.ts`
- Test: `cmd/klyx/frontend/src/store/gitops.test.ts`

- [ ] **Step 1: Add the failing store test**

`cmd/klyx/frontend/src/store/gitops.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useFleet, FluxResourceDTO } from "./fleet";

const r = (over: Partial<FluxResourceDTO>): FluxResourceDTO => ({
  kind: "Kustomization", namespace: "flux-system", name: "flux-system",
  ready: "Ready", message: "", revision: "main@abc", lastAppliedAgeSeconds: 1, suspended: false, ...over,
});

beforeEach(() => useFleet.setState({ gitops: { cluster: null, resources: [], loading: false } }));

describe("gitops store", () => {
  it("setGitOps stores resources for a cluster", () => {
    useFleet.getState().setGitOps("x", [r({ name: "a" })]);
    const g = useFleet.getState().gitops;
    expect(g.cluster).toBe("x");
    expect(g.resources).toHaveLength(1);
    expect(g.loading).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: from `cmd/klyx/frontend/`: `npx vitest run src/store/gitops.test.ts`
Expected: FAIL - `FluxResourceDTO`/`gitops`/`setGitOps` undefined.

- [ ] **Step 3: Extend the store `cmd/klyx/frontend/src/store/fleet.ts`**

Add the type and slice (append to the existing file):
```ts
export type FluxResourceDTO = {
  kind: string;
  namespace: string;
  name: string;
  ready: string;
  message: string;
  revision: string;
  lastAppliedAgeSeconds: number;
  suspended: boolean;
};

export type GitOpsSlice = {
  cluster: string | null;
  resources: FluxResourceDTO[];
  loading: boolean;
};
```
Add `gitops: GitOpsSlice` and `setGitOps` to `FleetState` and the store:
```ts
  gitops: GitOpsSlice;
  setGitOps: (cluster: string, resources: FluxResourceDTO[]) => void;
  setGitOpsLoading: (cluster: string) => void;
  clearGitOps: () => void;
```
In the `create(...)` body:
```ts
  gitops: { cluster: null, resources: [], loading: false },
  setGitOps: (cluster, resources) => set({ gitops: { cluster, resources, loading: false } }),
  setGitOpsLoading: (cluster) => set({ gitops: { cluster, resources: [], loading: true } }),
  clearGitOps: () => set({ gitops: { cluster: null, resources: [], loading: false } }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/store/gitops.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `cmd/klyx/frontend/src/bridge/gitops.ts`**

Adapt the binding import to the generated path (Task 5 generates it - likely `../../bindings/github.com/moomora/klyx/internal/appbridge`, the same module index that exports `FleetService`; it should also export `GitOpsService`):
```ts
import { useFleet, FluxResourceDTO } from "../store/fleet";
import { Events } from "@wailsio/runtime";
import { GitOpsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge";

const GITOPS_UPDATED = "gitops:updated";

export async function openGitOps(cluster: string): Promise<() => void> {
  useFleet.getState().setGitOpsLoading(cluster);
  await GitOpsService.Open(cluster);
  const off = Events.On(GITOPS_UPDATED, (ev: { data: { cluster: string; resources: FluxResourceDTO[] } }) => {
    const d = ev.data;
    if (d && d.cluster === cluster) {
      useFleet.getState().setGitOps(cluster, d.resources ?? []);
    }
  });
  return typeof off === "function" ? off : () => {};
}

export async function closeGitOps(cluster: string): Promise<void> {
  try {
    await GitOpsService.Close(cluster);
  } finally {
    useFleet.getState().clearGitOps();
  }
}
```

- [ ] **Step 6: Build + commit**

Run: `npm run build` (resolves the binding import). If the generated `GitOpsService` path differs, fix the import to match `cmd/klyx/frontend/bindings/...`.
```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/gitops.test.ts cmd/klyx/frontend/src/bridge/gitops.ts
git commit -m "$(printf 'feat: gitops store slice + open/close bridge\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: GitOps view + ClusterDetail wiring

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`
- Test: `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`

- [ ] **Step 1: Write the failing test**

`cmd/klyx/frontend/src/cluster/GitOps.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet, FluxResourceDTO, ClusterDTO } from "../store/fleet";
import { GitOps } from "./GitOps";

const cluster = (tier: string): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v1",
  gitopsTier: tier, gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0,
});
const res = (over: Partial<FluxResourceDTO>): FluxResourceDTO => ({
  kind: "Kustomization", namespace: "flux-system", name: "flux-system", ready: "Ready",
  message: "", revision: "main@abc", lastAppliedAgeSeconds: 1, suspended: false, ...over,
});

beforeEach(() => useFleet.setState({
  clusters: [cluster("Healthy")],
  gitops: { cluster: "x", resources: [], loading: false },
}));

describe("GitOps view", () => {
  it("renders the resource table from the store", () => {
    useFleet.setState({ gitops: { cluster: "x", resources: [
      res({ name: "flux-system", ready: "Ready" }),
      res({ kind: "HelmRelease", name: "cilium", ready: "Failed", message: "install failed" }),
    ], loading: false } });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText("flux-system/flux-system")).toBeTruthy();
    expect(getByText("flux-system/cilium")).toBeTruthy();
    expect(getByText(/install failed/i)).toBeTruthy();
  });

  it("shows the no-Flux empty state when gitopsTier is Absent and does not open", () => {
    useFleet.setState({ clusters: [cluster("Absent")] });
    const { getByText } = render(<GitOps cluster="x" />);
    expect(getByText(/No Flux or Argo/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cluster/GitOps.test.tsx`
Expected: FAIL - `GitOps` not found.

- [ ] **Step 3: Implement `cmd/klyx/frontend/src/cluster/GitOps.tsx`**

```tsx
import { useEffect } from "react";
import { useFleet, FluxResourceDTO } from "../store/fleet";
import { openGitOps, closeGitOps } from "../bridge/gitops";

const readyColor: Record<string, string> = {
  Ready: "var(--color-text-success)",
  Reconciling: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unknown: "var(--color-text-tertiary)",
};

export function GitOps({ cluster }: { cluster: string }) {
  const tier = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.gitopsTier ?? "Unknown");
  const gitops = useFleet((s) => s.gitops);
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
          {rows.map((r) => <Row key={`${r.kind}/${r.namespace}/${r.name}`} r={r} />)}
        </div>
      )}
    </div>
  );
}

function Row({ r }: { r: FluxResourceDTO }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12 }}>
      <div>
        <span style={{ fontFamily: "var(--font-mono)" }}>{r.namespace}/{r.name}</span>{" "}
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{r.kind === "Kustomization" ? "ks" : "hr"}</span>
        {r.message && r.ready === "Failed" && (
          <div style={{ color: "var(--color-text-danger)", fontSize: 11, marginTop: 2 }}>{r.message}</div>
        )}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)" }}>{r.revision}</div>
      <div style={{ color: readyColor[r.ready] ?? "var(--color-text-tertiary)" }}>
        {r.suspended ? "suspended" : r.ready.toLowerCase()}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire `ClusterDetail.tsx`**

In `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`, import `GitOps` and route the `gitops` section to it; the other sections keep the `Placeholder`:
```tsx
import { GitOps } from "./GitOps";
// ...
  if (route.section === "overview") return <Overview c={cluster} />;
  if (route.section === "gitops") return <GitOps cluster={cluster.name} />;
  return <Placeholder section={route.section} c={cluster} />;
```
(Replace the existing final `return route.section === "overview" ? <Overview .../> : <Placeholder .../>;` with the three-branch form above.)

- [ ] **Step 5: Run tests + build**

Run: from `cmd/klyx/frontend/`: `npx vitest run` then `npm run build`
Expected: all pass (incl. the new GitOps tests); builds. (The GitOps test sets `gitopsTier: "Absent"` for the no-open case so `openGitOps` - which imports the Wails binding - is never called in tests; the Healthy case relies on the store being pre-seeded, and `openGitOps`'s binding call is fired in an effect but its result is irrelevant to the assertions. If the binding import makes vitest fail to load, mock it: add `vi.mock("../bridge/gitops", () => ({ openGitOps: async () => () => {}, closeGitOps: async () => {} }))` at the top of the test.)

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/GitOps.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx cmd/klyx/frontend/src/cluster/GitOps.test.tsx
git commit -m "$(printf 'feat: live GitOps reconciliation view wired into cluster detail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 8: Full verification + native handoff

**Files:** none (verification).

- [ ] **Step 1: Whole Go suite + race + vet**

Run: `make test && make vet && go test -race ./internal/...`
Expected: all packages pass, vet clean, no race.

- [ ] **Step 2: Frontend suite + build**

Run: `cd cmd/klyx/frontend && npx vitest run && npm run build`
Expected: all tests pass; builds.

- [ ] **Step 3: Headless dev smoke (best-effort) + native handoff**

If `$HOME/.config/klyx/fleet.yaml` is reachable, start `wails3 dev` (`export PATH="$HOME/go/bin:$PATH"`), and with the browser tools open the dev URL, drill into `homelab-nelli`, click the GitOps rail icon, and confirm the Flux Kustomization/HelmRelease rows render with statuses. Stop dev. If unreachable, defer.

In the report, give the user the native command and what to confirm:
```
cd cmd/klyx && export PATH="$HOME/go/bin:$PATH" && KLYX_CONFIG="$HOME/.config/klyx/fleet.yaml" wails3 dev
# Drill into homelab-nelli -> GitOps: expect the Flux resources (flux-system, and any HelmReleases) with ready/reconciling/failed status, revisions, and live updates.
```

---

## Self-Review

**Spec coverage:**
- §2.1 flux types + parsers (unstructured) → Task 1. ✓
- §2.2 lazy `OpenGitOps/CloseGitOps/GitOpsResources`, dynamic client, GVR version resolution via discovery → Task 2. ✓
- §3 `FluxResourceDTO`+`ToFluxDTO` → Task 3; `GitOpsService` Open/Close + `gitops:updated` push + `Registry.Conn` lookup → Tasks 2 (Conn), 4, 5. ✓
- §4 store slice, `bridge/gitops.ts`, `GitOps.tsx` (Absent skips open; summary; table; loading), `ClusterDetail` routing → Tasks 6, 7. ✓
- §5 tests: flux parsers (T1), DTO+service (T3,T4), lazy watch via dynamic fake (T2), frontend GitOps + store (T6,T7), Playwright/native (T8). ✓

**Placeholder scan:** none. The explicit `ADAPT`-style notes are: the dynamic-fake constructor (T2 Step 7), the generated binding path (T6 Step 5), and the optional `vi.mock` for the GitOps test (T7 Step 5) - all concrete fallbacks for pinned-version/binding specifics, not vague TODOs. The two `var _ =` guards in T1/T2 are explicitly flagged for removal if unused.

**Type consistency:** `flux.Resource`/`Kind`/`ReadyState`/`ParseKustomization`/`ParseHelmRelease` (T1) are used by the watch (T2), `ToFluxDTO` (T3), and `GitOpsService` (T4). The `Conn` interface's three new methods (T2) are implemented by `ClusterConn` (T2), stubbed in `fakeConn` (T2), and consumed via `Registry.Conn`→`appbridge.GitOpsConn` closure (T5). `FluxResourceDTO` Go fields (T3) match the TS type (T6) one-for-one (camelCase json). `gitops:updated` / `GitOpsUpdatedEvent` consistent (T4, T6). `openGitOps/closeGitOps/setGitOps/setGitOpsLoading/clearGitOps` consistent across T6, T7. `NewClusterConn`'s new `dyn` param (T2) is passed by `DefaultConnFactory` (T2 Step 2) and `nil` by the existing conn/caphealth tests (T2 Step 2).
```
