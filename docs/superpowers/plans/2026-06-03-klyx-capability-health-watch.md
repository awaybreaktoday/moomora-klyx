# Klyx Capability Health Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitOps capability health live and event-driven - watch the controller workloads (`kustomize-controller` Deployment, `argocd-application-controller` StatefulSet) so a cluster flips `Healthy ↔ Degraded` reactively, finally firing both `EvCapHealthy` and `EvCapUnhealthy`.

**Architecture:** Small pure refactor in `internal/capability` (extract readiness + tier helpers; add `ControllerRefs` and `WithGitOpsHealth`), a new `internal/fleet/caphealth.go` monitor that watches the controller workloads via namespace-scoped informers and recomputes the tier from their stores, and two touches in `conn.go` (`applyGitOpsHealth` driving the FSM atomically; start the monitor after connect). No FSM change.

**Tech Stack:** Go 1.22+, `k8s.io/client-go` (informers, `cache`), `k8s.io/api/apps/v1`. Fakes: `client-go/kubernetes/fake`, `client-go/metadata/fake`, `client-go/discovery/fake`.

**Spec:** `docs/superpowers/specs/2026-06-03-klyx-capability-health-watch-design.md`

**Files touched:** `internal/capability/detector.go` (+ new `gitops_health.go` + tests), `internal/fleet/caphealth.go` (new + test), `internal/fleet/conn.go`.

---

### Task 1: Extract readiness + tier helpers in `internal/capability`

Behavior-preserving refactor: pull `DeploymentReady`/`StatefulSetReady` and `gitOpsTier` out of `controllerHealthy`/`detectGitOps` so the live monitor (Task 3) can reuse them.

**Files:**
- Modify: `internal/capability/detector.go`
- Test: `internal/capability/detector_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `internal/capability/detector_test.go` (add `appsv1 "k8s.io/api/apps/v1"` to its imports):

```go
func TestDeploymentReady(t *testing.T) {
	cases := []struct {
		avail    int32
		replicas *int32
		want     bool
	}{
		{avail: 1, replicas: ptr(int32(1)), want: true},
		{avail: 0, replicas: ptr(int32(1)), want: false},
		{avail: 2, replicas: ptr(int32(3)), want: false},
		{avail: 1, replicas: nil, want: true}, // nil replicas defaults to 1
		{avail: 0, replicas: nil, want: false},
	}
	for _, tc := range cases {
		d := &appsv1.Deployment{
			Spec:   appsv1.DeploymentSpec{Replicas: tc.replicas},
			Status: appsv1.DeploymentStatus{AvailableReplicas: tc.avail},
		}
		if got := DeploymentReady(d); got != tc.want {
			t.Errorf("DeploymentReady(avail=%d, repl=%v)=%v want %v", tc.avail, tc.replicas, got, tc.want)
		}
	}
}

func TestStatefulSetReady(t *testing.T) {
	d := &appsv1.StatefulSet{
		Spec:   appsv1.StatefulSetSpec{Replicas: ptr(int32(1))},
		Status: appsv1.StatefulSetStatus{ReadyReplicas: 1},
	}
	if !StatefulSetReady(d) {
		t.Fatal("want ready")
	}
	d.Status.ReadyReplicas = 0
	if StatefulSetReady(d) {
		t.Fatal("want not ready")
	}
}

func TestGitOpsTier(t *testing.T) {
	// Flux present and healthy -> Healthy, empty reason.
	tier, reason := gitOpsTier(FluxInfo{Present: true, Healthy: true}, ArgoInfo{})
	if tier != Healthy || reason != "" {
		t.Fatalf("want Healthy/empty, got %v/%q", tier, reason)
	}
	// Flux present but unhealthy -> Degraded with a reason naming the controller.
	tier, reason = gitOpsTier(FluxInfo{Present: true, Healthy: false}, ArgoInfo{})
	if tier != Degraded || reason == "" {
		t.Fatalf("want Degraded/reason, got %v/%q", tier, reason)
	}
}
```

(The `ptr` helper already exists in `detector_test.go` from the foundation work.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capability/ -run 'TestDeploymentReady|TestStatefulSetReady|TestGitOpsTier' -v`
Expected: FAIL - `DeploymentReady`, `StatefulSetReady`, `gitOpsTier` undefined.

- [ ] **Step 3: Add the helpers and refactor in `internal/capability/detector.go`**

a) Add `appsv1 "k8s.io/api/apps/v1"` to the import block.

b) Add these helpers (place after the `workloadKind` const block):
```go
func desiredReplicas(r *int32) int32 {
	if r != nil {
		return *r
	}
	return 1
}

// DeploymentReady reports whether a Deployment has its desired replicas available.
func DeploymentReady(d *appsv1.Deployment) bool {
	return d.Status.AvailableReplicas >= desiredReplicas(d.Spec.Replicas)
}

// StatefulSetReady reports whether a StatefulSet has its desired replicas ready.
func StatefulSetReady(s *appsv1.StatefulSet) bool {
	return s.Status.ReadyReplicas >= desiredReplicas(s.Spec.Replicas)
}

// gitOpsTier computes the GitOps tier and reason from per-tool presence/health.
// Callers handle the all-absent case before calling this.
func gitOpsTier(flux FluxInfo, argo ArgoInfo) (Tier, string) {
	var reasons []string
	if flux.Present && !flux.Healthy {
		reasons = append(reasons, "Flux installed but "+fluxKustomizeController+" is not ready")
	}
	if argo.Present && !argo.Healthy {
		reasons = append(reasons, "Argo installed but "+argoAppController+" is not ready")
	}
	fluxOK := !flux.Present || flux.Healthy
	argoOK := !argo.Present || argo.Healthy
	return Classify(true, fluxOK && argoOK), strings.Join(reasons, "; ")
}
```

c) Replace `controllerHealthy` (the whole method) with a boolean-only `controllerReady`:
```go
// controllerReady reports whether a controller workload has its desired replicas
// ready. Deployments check AvailableReplicas; StatefulSets check ReadyReplicas.
func (d *Detector) controllerReady(ctx context.Context, kind workloadKind, ns, name string) bool {
	switch kind {
	case statefulSetWorkload:
		sts, err := d.cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false
		}
		return StatefulSetReady(sts)
	default: // deploymentWorkload
		dep, err := d.cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false
		}
		return DeploymentReady(dep)
	}
}
```

d) Replace the body of `detectGitOps` (keep the signature) with:
```go
func (d *Detector) detectGitOps(ctx context.Context, served map[string]bool) GitOpsCapability {
	fluxPresent := served["kustomize.toolkit.fluxcd.io"]
	argoPresent := served["argoproj.io"]

	out := GitOpsCapability{}
	out.Flux.Present = fluxPresent
	out.Argo.Present = argoPresent
	out.Coexistence = fluxPresent && argoPresent

	if !fluxPresent && !argoPresent {
		out.Base = Base{Tier: Absent, Reason: "no Flux or Argo CRDs installed"}
		return out
	}

	if fluxPresent {
		out.Flux.Healthy = d.controllerReady(ctx, deploymentWorkload, fluxNamespace, fluxKustomizeController)
		if out.Flux.Healthy {
			out.Flux.Controllers = []string{fluxKustomizeController}
		}
	}
	if argoPresent {
		out.Argo.Healthy = d.controllerReady(ctx, statefulSetWorkload, argoNamespace, argoAppController)
	}

	tier, reason := gitOpsTier(out.Flux, out.Argo)
	out.Base.Tier = tier
	out.Base.Reason = reason
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/capability/ -v`
Expected: PASS - the three new tests AND all existing detector tests (TestDetectFluxAbsent, TestDetectFluxPresentButUnhealthy, TestDetectFluxHealthy, TestDetectArgoHealthy, TestDetectArgoPresentButUnhealthy, TestDetectGatewayPresentWithoutEnvoyProxyIsDegraded). The existing ones assert tiers and non-empty reasons, which the refactor preserves.

- [ ] **Step 5: Vet and commit**

Run: `go vet ./internal/capability/`
```bash
git add internal/capability/detector.go internal/capability/detector_test.go
git commit -m "$(printf 'refactor: extract DeploymentReady/StatefulSetReady/gitOpsTier in capability\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `ControllerRefs` and `WithGitOpsHealth`

New exported API the monitor uses: which workloads to watch, and how to recompute the GitOps capability from fresh readiness.

**Files:**
- Create: `internal/capability/gitops_health.go`
- Test: `internal/capability/gitops_health_test.go`

- [ ] **Step 1: Write the failing tests**

`internal/capability/gitops_health_test.go`:
```go
package capability

import "testing"

func TestControllerRefs(t *testing.T) {
	fluxOnly := Set{GitOps: GitOpsCapability{Flux: FluxInfo{Present: true}}}
	refs := ControllerRefs(fluxOnly)
	if len(refs) != 1 || refs[0].Tool != "flux" || refs[0].Kind != "Deployment" ||
		refs[0].Namespace != "flux-system" || refs[0].Name != "kustomize-controller" {
		t.Fatalf("flux-only refs wrong: %+v", refs)
	}

	argoOnly := Set{GitOps: GitOpsCapability{Argo: ArgoInfo{Present: true}}}
	refs = ControllerRefs(argoOnly)
	if len(refs) != 1 || refs[0].Tool != "argo" || refs[0].Kind != "StatefulSet" ||
		refs[0].Namespace != "argocd" || refs[0].Name != "argocd-application-controller" {
		t.Fatalf("argo-only refs wrong: %+v", refs)
	}

	both := Set{GitOps: GitOpsCapability{Flux: FluxInfo{Present: true}, Argo: ArgoInfo{Present: true}}}
	if len(ControllerRefs(both)) != 2 {
		t.Fatalf("both: want 2 refs")
	}

	if len(ControllerRefs(Set{})) != 0 {
		t.Fatalf("neither: want 0 refs")
	}
}

func TestWithGitOpsHealth(t *testing.T) {
	base := Set{GitOps: GitOpsCapability{
		Base: Base{Tier: Healthy},
		Flux: FluxInfo{Present: true, Version: "v2.4.0", Healthy: true},
	}}

	// Healthy -> Healthy, preserves version, populates Controllers, empty reason.
	g := WithGitOpsHealth(base, true, false)
	if g.Tier != Healthy || g.Reason != "" {
		t.Fatalf("want Healthy/empty, got %v/%q", g.Tier, g.Reason)
	}
	if g.Flux.Version != "v2.4.0" {
		t.Fatalf("version not preserved: %q", g.Flux.Version)
	}
	if len(g.Flux.Controllers) != 1 {
		t.Fatalf("want Controllers populated when healthy")
	}

	// Unhealthy -> Degraded with reason, Controllers cleared.
	g = WithGitOpsHealth(base, false, false)
	if g.Tier != Degraded || g.Reason == "" {
		t.Fatalf("want Degraded/reason, got %v/%q", g.Tier, g.Reason)
	}
	if len(g.Flux.Controllers) != 0 {
		t.Fatalf("want Controllers cleared when unhealthy")
	}

	// Coexistence preserved; flipping argo unhealthy degrades the combined tier.
	co := Set{GitOps: GitOpsCapability{
		Base:        Base{Tier: Healthy},
		Flux:        FluxInfo{Present: true, Healthy: true},
		Argo:        ArgoInfo{Present: true, Healthy: true},
		Coexistence: true,
	}}
	g = WithGitOpsHealth(co, true, false)
	if g.Tier != Degraded {
		t.Fatalf("want Degraded when argo unhealthy, got %v", g.Tier)
	}
	if !g.Coexistence {
		t.Fatal("coexistence must be preserved")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capability/ -run 'TestControllerRefs|TestWithGitOpsHealth' -v`
Expected: FAIL - `ControllerRefs`, `WithGitOpsHealth`, `ControllerRef` undefined.

- [ ] **Step 3: Implement `internal/capability/gitops_health.go`**

```go
package capability

// ControllerRef identifies a GitOps controller workload to watch for health.
type ControllerRef struct {
	Tool      string // "flux" | "argo"
	Kind      string // "Deployment" | "StatefulSet"
	Namespace string
	Name      string
}

// ControllerRefs returns the controller workloads to watch for the GitOps tools
// present in s. Empty if neither Flux nor Argo is present.
func ControllerRefs(s Set) []ControllerRef {
	var refs []ControllerRef
	if s.GitOps.Flux.Present {
		refs = append(refs, ControllerRef{
			Tool: "flux", Kind: "Deployment",
			Namespace: fluxNamespace, Name: fluxKustomizeController,
		})
	}
	if s.GitOps.Argo.Present {
		refs = append(refs, ControllerRef{
			Tool: "argo", Kind: "StatefulSet",
			Namespace: argoNamespace, Name: argoAppController,
		})
	}
	return refs
}

// WithGitOpsHealth returns a copy of s.GitOps with the tier, reason, and per-tool
// Healthy flags recomputed from fresh controller readiness. Presence, version,
// and coexistence are preserved. Readiness args are consulted only for tools that
// are present in s.
func WithGitOpsHealth(s Set, fluxHealthy, argoHealthy bool) GitOpsCapability {
	out := s.GitOps
	if out.Flux.Present {
		out.Flux.Healthy = fluxHealthy
		if fluxHealthy {
			out.Flux.Controllers = []string{fluxKustomizeController}
		} else {
			out.Flux.Controllers = nil
		}
	}
	if out.Argo.Present {
		out.Argo.Healthy = argoHealthy
	}
	tier, reason := gitOpsTier(out.Flux, out.Argo)
	out.Base.Tier = tier
	out.Base.Reason = reason
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/capability/ -v`
Expected: PASS (new tests + all existing).

- [ ] **Step 5: Vet and commit**

Run: `go vet ./internal/capability/`
```bash
git add internal/capability/gitops_health.go internal/capability/gitops_health_test.go
git commit -m "$(printf 'feat: ControllerRefs and WithGitOpsHealth for live capability health\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Capability health monitor + conn wiring

Watch the controller workloads and reassert the GitOps tier reactively, driving both cap-state edges. Integration test proves `Healthy → Degraded → Healthy` live.

**Files:**
- Create: `internal/fleet/caphealth.go`
- Modify: `internal/fleet/conn.go`
- Test: `internal/fleet/caphealth_test.go`

- [ ] **Step 1: Write the failing integration test**

`internal/fleet/caphealth_test.go`:
```go
package fleet

import (
	"context"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
)

func i32(v int32) *int32 { return &v }

func kustomizeDeploy(avail int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "kustomize-controller", Namespace: "flux-system"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1)},
		Status:     appsv1.DeploymentStatus{AvailableReplicas: avail},
	}
}

func TestCapHealthReactsToControllerHealth(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
		kustomizeDeploy(1),
	)
	// Flux CRD served, so the GitOps capability is present.
	typed.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "kustomize.toolkit.fluxcd.io/v1"},
	}

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme, podMeta("p1", "default"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, det, clock.Real{})
	c.Start(ctx)

	// Initially healthy.
	waitFor(t, 3*time.Second, func() bool {
		s := c.Snapshot()
		return s.State == Synced && s.Capabilities.GitOps.Tier == capability.Healthy
	})

	// Controller crashes -> Degraded, reactively.
	if _, err := typed.AppsV1().Deployments("flux-system").Update(ctx, kustomizeDeploy(0), metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update to 0: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		s := c.Snapshot()
		return s.State == Degraded && s.Capabilities.GitOps.Tier == capability.Degraded && s.Reason != ""
	})

	// Controller recovers -> Synced again (exercises EvCapHealthy).
	if _, err := typed.AppsV1().Deployments("flux-system").Update(ctx, kustomizeDeploy(1), metav1.UpdateOptions{}); err != nil {
		t.Fatalf("update to 1: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		s := c.Snapshot()
		return s.State == Synced && s.Capabilities.GitOps.Tier == capability.Healthy && s.Reason == ""
	})
}
```

Note: the typed `fake.Clientset`'s `Update` propagates a watch MODIFY event to the Deployment informer, which is what drives the reactive recompute. The namespace-scoped, name-filtered informer works because the fixture has exactly one Deployment in `flux-system`; the fake may not honor field selectors, but that is harmless here (production relies on the real API server honoring them).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestCapHealthReactsToControllerHealth -v`
Expected: FAIL - `c.startCapHealth` / `c.applyGitOpsHealth` not yet called; the cluster stays `Synced/Healthy` and never reacts to the controller going to 0.

- [ ] **Step 3: Implement `internal/fleet/caphealth.go`**

```go
package fleet

import (
	"context"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/tools/cache"

	"github.com/moomora/klyx/internal/capability"
)

// capHealth watches the GitOps controller workloads for the present tools and
// recomputes the GitOps tier from their informer stores on every change.
type capHealth struct {
	set     capability.Set
	fluxInf cache.SharedIndexInformer // nil if Flux absent
	argoInf cache.SharedIndexInformer // nil if Argo absent
	apply   func(capability.GitOpsCapability)
}

// startCapHealth begins watching controller health for the present GitOps tools.
// No-op when no GitOps tool is present. Informers run on ctx (parent), so they
// retry/relist alongside the eager set.
func (c *ClusterConn) startCapHealth(ctx context.Context, set capability.Set) {
	refs := capability.ControllerRefs(set)
	if len(refs) == 0 {
		return
	}

	h := &capHealth{set: set, apply: c.applyGitOpsHealth}

	for _, ref := range refs {
		factory := informers.NewSharedInformerFactoryWithOptions(c.typed, defaultResync,
			informers.WithNamespace(ref.Namespace),
			informers.WithTweakListOptions(func(o *metav1.ListOptions) {
				o.FieldSelector = "metadata.name=" + ref.Name
			}),
		)
		var inf cache.SharedIndexInformer
		switch ref.Kind {
		case "Deployment":
			inf = factory.Apps().V1().Deployments().Informer()
			h.fluxInf = inf
		case "StatefulSet":
			inf = factory.Apps().V1().StatefulSets().Informer()
			h.argoInf = inf
		}
		_, _ = inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(interface{}) { h.recompute() },
			UpdateFunc: func(interface{}, interface{}) { h.recompute() },
			DeleteFunc: func(interface{}) { h.recompute() },
		})
		factory.Start(ctx.Done())
	}
}

// recompute reads controller readiness from the informer stores and applies the
// resulting GitOps capability. It waits until all present controller informers
// have synced, to avoid a spurious Degraded before the first list completes.
func (h *capHealth) recompute() {
	if h.fluxInf != nil && !h.fluxInf.HasSynced() {
		return
	}
	if h.argoInf != nil && !h.argoInf.HasSynced() {
		return
	}
	fluxHealthy := h.fluxInf == nil || deploymentReadyFromStore(h.fluxInf)
	argoHealthy := h.argoInf == nil || statefulSetReadyFromStore(h.argoInf)
	h.apply(capability.WithGitOpsHealth(h.set, fluxHealthy, argoHealthy))
}

func deploymentReadyFromStore(inf cache.SharedIndexInformer) bool {
	for _, obj := range inf.GetStore().List() {
		if d, ok := obj.(*appsv1.Deployment); ok {
			return capability.DeploymentReady(d)
		}
	}
	return false // workload absent -> not ready
}

func statefulSetReadyFromStore(inf cache.SharedIndexInformer) bool {
	for _, obj := range inf.GetStore().List() {
		if s, ok := obj.(*appsv1.StatefulSet); ok {
			return capability.StatefulSetReady(s)
		}
	}
	return false
}
```

- [ ] **Step 4: Wire `conn.go`**

a) Add the `applyGitOpsHealth` method to `internal/fleet/conn.go` (place it after `capabilityReason`):
```go
// applyGitOpsHealth updates the GitOps capability and drives the cap-state edges
// (EvCapUnhealthy / EvCapHealthy) atomically under one lock. Reason is set on
// Degraded and cleared on Healthy. Outside Synced/Degraded the transition is a
// no-op, but caps are still updated so recovery reflects the latest health.
func (c *ClusterConn) applyGitOpsHealth(g capability.GitOpsCapability) {
	var ev Event
	switch g.Tier {
	case capability.Degraded:
		ev = EvCapUnhealthy
	case capability.Healthy:
		ev = EvCapHealthy
	default: // Absent: should not occur for a present tool
		c.mu.Lock()
		c.caps.GitOps = g
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	c.caps.GitOps = g
	if next, ok := Transition(c.state, ev); ok {
		c.state = next
		c.reason = g.Reason
	}
	c.mu.Unlock()
}
```

b) In `connectLoop`, in the `if ok {` success branch, AFTER the existing
`if caps.GitOps.Tier == capability.Degraded || ... { c.setState(EvCapUnhealthy, ...) }`
block and BEFORE the `return`, add:
```go
			c.startCapHealth(ctx, caps)
```
So the tail of the success branch reads:
```go
			if caps.GitOps.Tier == capability.Degraded || caps.Network.Tier == capability.Degraded {
				c.setState(EvCapUnhealthy, capabilityReason(caps))
			}
			c.startCapHealth(ctx, caps)
			return
```

- [ ] **Step 5: Run the integration test**

Run: `go test ./internal/fleet/ -run TestCapHealthReactsToControllerHealth -v`
Expected: PASS - the cluster goes Synced/Healthy, then Degraded when the controller drops to 0 available, then back to Synced/Healthy when it recovers.

- [ ] **Step 6: Race + full fleet package, repeatedly**

Run: `go test -race -count=5 ./internal/fleet/`
Expected: all pass across 5 runs, no race. (Confirms the monitor's `applyGitOpsHealth` and the connect/refresh loops are correctly serialised by `c.mu`.)

- [ ] **Step 7: Vet + full repo**

Run: `go vet ./... && go test ./... -count=1`
Expected: vet clean; all packages pass.

- [ ] **Step 8: Commit**

```bash
git add internal/fleet/caphealth.go internal/fleet/conn.go internal/fleet/caphealth_test.go
git commit -m "$(printf 'feat: live GitOps controller-health watch (reactive Healthy<->Degraded)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage (against `2026-06-03-klyx-capability-health-watch-design.md`):**

- 3.1 readiness helpers (`DeploymentReady`/`StatefulSetReady`) + `gitOpsTier` extraction, `controllerHealthy` rewritten -> Task 1. ✓
- 3.1 `ControllerRef`/`ControllerRefs` + `WithGitOpsHealth` -> Task 2. ✓
- 3.2 `caphealth.go` monitor: namespace-scoped name-filtered informers, recompute-from-stores, no-op when no GitOps tool, parent-ctx informers, sync guard -> Task 3 Step 3. ✓
- 3.3 `conn.go`: `startCapHealth` called in connectLoop success branch; `applyGitOpsHealth` atomic under one lock via pure `Transition` -> Task 3 Step 4. ✓
- 3.4 FSM unchanged; both edges exercised; recovery reasserts via controller relist (covered by the parent-ctx informers) -> Task 3 (no FSM change). ✓
- 4.1 capability pure tests -> Tasks 1-2. ✓
- 4.2 live integration test Healthy->Degraded->Healthy via typed fake Update + `-race -count=5` -> Task 3 Steps 1, 6. ✓
- 4.3 regression: existing capability + fleet tests run in Task 1 Step 4 and Task 3 Step 7. ✓

**Placeholder scan:** none. Code is complete in every step.

**Type consistency:** `DeploymentReady`/`StatefulSetReady`/`gitOpsTier` (Task 1) are used by `WithGitOpsHealth` (Task 2) and the monitor's store helpers (Task 3). `ControllerRef.Kind` strings `"Deployment"`/`"StatefulSet"` (Task 2) match the `switch ref.Kind` arms (Task 3). `WithGitOpsHealth`/`ControllerRefs` (Task 2) are consumed by `capHealth.recompute`/`startCapHealth` (Task 3). `applyGitOpsHealth` (Task 3 Step 4a) is the `apply` callback wired in `startCapHealth` (Task 3 Step 3). `capability.Degraded`/`Healthy`/`Set`/`GitOpsCapability`, `Transition`, `EvCapUnhealthy`/`EvCapHealthy`, `c.mu`/`c.caps`/`c.state`/`c.reason`, `defaultResync`, `podMeta`, `waitFor` all already exist. Consistent.
```
