# Klyx M10 Implementation Plan (Flux diagnosis depth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Klyx able to diagnose a stuck Flux resource without dropping to a terminal - surface the bound source's health, the failing condition's reason, the `dependsOn` chain, and the drift surface (Flux's own telemetry), plus a `reconcile --with-source` day-2 action and an on-demand `flux diff` escape hatch for suspended/failing resources. Read or day-2-drive only.

**Architecture:** All four diagnostic signals already live on objects the gitops watch can see (source CRs in `source.toolkit.fluxcd.io`, the `Ready` condition's reason, `spec.dependsOn`, and core/v1 Events). M10 watches the five source kinds alongside ks/hr, extends the pure flux parsers with `Reason`/`DependsOn`/`Source`, threads them through the appbridge DTOs and the `gitops:updated` push, and renders them in the existing two-pane GitOps view. One new write (`ReconcileWithSource`) follows the existing `Reconcile` path exactly.

**Tech Stack:** Go + client-go (`unstructured`, dynamic informers, core/v1 Events); React + TS + Zustand. Frontend root `cmd/klyx/frontend/`. No `main.go` change needed for new `GitOpsService` methods - they bind on the next `wails3 build`; the `main.go` wiring only changes if a new service is introduced (it is not).

**Spec:** `docs/superpowers/specs/2026-06-17-klyx-flux-diagnosis-design.md`

**Sub-milestones (ship independently, in order):**
- **M10-a** Source health (watch source kinds; bound-source status in detail; sources filter)
- **M10-b** Reconcile with source (day-2 action)
- **M10-c** Failure-reason surfacing (Ready reason → row + header chip)
- **M10-d** `dependsOn` blocked-by (detail section + DependencyNotReady headline)
- **M10-e** Drift surface — read Flux's telemetry (involvedObject Events + conditions + inventory) as the default "what drifted" view
- **M10-f** On-demand `flux diff` escape hatch, scoped to suspended / apply-failing resources

**Drift design (spec §1.1):** Flux auto-heals drift every reconcile, so a standing live-vs-Git divergence does not exist on a healthy Kustomization and a default Git diff would be empty. The truthful, zero-credential drift signal is Flux's own telemetry (events naming corrected objects + conditions + inventory) — that is M10-e and the default. A real Git-rendered diff only adds value on **suspended** or **apply-failing** resources, so M10-f shells out to `flux diff` **on demand only there**. Shelling out (not a native Go engine) is deliberate: the `flux` CLI already handles SOPS via age/GPG + AWS/Azure/GCP KMS using the shell's per-cloud auth — the whole four-provider matrix — for free.

**Out of scope (per spec §2):** always-on / native Git-render diff engine, pre-merge branch preview, `flux diff` for HelmReleases (no such subcommand), image-automation kinds, notification-controller console, per-inventory-object kstatus readiness.

---
---

# M10-a — Source health

### Task 1: `flux.Source` + `ParseSource` + `BoundSource`

**Files:**
- Modify: `internal/gitops/flux/flux.go`
- Test: `internal/gitops/flux/source_test.go`

- [ ] **Step 1: Write the failing test** — `internal/gitops/flux/source_test.go`:
```go
package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func gitRepoObj(ready string, reason string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1",
		"kind":       "GitRepository",
		"metadata":   map[string]interface{}{"name": "podinfo", "namespace": "flux-system"},
		"spec":       map[string]interface{}{"url": "https://github.com/org/repo"},
		"status": map[string]interface{}{
			"artifact": map[string]interface{}{"revision": "main@sha1:abcdef0"},
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": ready, "reason": reason, "message": "stored artifact"},
			},
		},
	}}
}

func TestParseSourceReady(t *testing.T) {
	s := ParseSource(gitRepoObj("True", "Succeeded"))
	if s.Kind != GitRepositoryKind || s.Name != "podinfo" || s.Namespace != "flux-system" {
		t.Fatalf("identity: %+v", s)
	}
	if s.Ready != Ready {
		t.Fatalf("ready: %q", s.Ready)
	}
	if s.Revision != "main@sha1:abcdef0" {
		t.Fatalf("revision: %q", s.Revision)
	}
	if s.URL != "https://github.com/org/repo" {
		t.Fatalf("url: %q", s.URL)
	}
}

func TestParseSourceFailedCarriesReason(t *testing.T) {
	s := ParseSource(gitRepoObj("False", "GitOperationFailed"))
	if s.Ready != Failed || s.Reason != "GitOperationFailed" {
		t.Fatalf("failed source: %+v", s)
	}
}

func TestBoundSourceKustomization(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Kustomization",
		"metadata": map[string]interface{}{"name": "apps", "namespace": "flux-system"},
		"spec": map[string]interface{}{
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"},
		},
	}}
	b, ok := BoundSource(u)
	if !ok || b.Kind != "GitRepository" || b.Name != "flux-system" || b.Namespace != "flux-system" {
		t.Fatalf("bound: %+v ok=%v", b, ok)
	}
}

func TestBoundSourceHelmReleaseChartRef(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "HelmRelease",
		"metadata": map[string]interface{}{"name": "cilium", "namespace": "kube-system"},
		"spec": map[string]interface{}{
			"chartRef": map[string]interface{}{"kind": "OCIRepository", "name": "cilium", "namespace": "flux-system"},
		},
	}}
	b, ok := BoundSource(u)
	if !ok || b.Kind != "OCIRepository" || b.Namespace != "flux-system" {
		t.Fatalf("bound: %+v ok=%v", b, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/gitops/flux/ -run 'TestParseSource|TestBoundSource' -v`
Expected: FAIL - undefined `Source`/`ParseSource`/`BoundSource`/source kind consts.

- [ ] **Step 3: Implement (append to `internal/gitops/flux/flux.go`)**

Add the source kind constants next to the existing `KustomizationKind`/`HelmReleaseKind` block, then append:
```go
const (
	GitRepositoryKind  Kind = "GitRepository"
	OCIRepositoryKind  Kind = "OCIRepository"
	BucketKind         Kind = "Bucket"
	HelmRepositoryKind Kind = "HelmRepository"
	HelmChartKind      Kind = "HelmChart"
)

// Source is a Flux source object's fetch state.
type Source struct {
	Kind      Kind
	Namespace string
	Name      string
	Ready     ReadyState
	Reason    string
	Message   string
	Revision  string
	URL       string
	Suspended bool
}

// ParseSource extracts a source's fetch state from a watched source CR. Reuses
// the Ready/Reconciling condition walk shared with common().
func ParseSource(u *unstructured.Unstructured) Source {
	s := Source{Kind: Kind(u.GetKind()), Namespace: u.GetNamespace(), Name: u.GetName()}
	s.Suspended, _, _ = unstructured.NestedBool(u.Object, "spec", "suspend")
	s.URL, _, _ = unstructured.NestedString(u.Object, "spec", "url")
	s.Revision, _, _ = unstructured.NestedString(u.Object, "status", "artifact", "revision")
	s.Ready, s.Reason, s.Message = readyFromConditions(u)
	return s
}

// SourceRef points at a source object bound to a Kustomization/HelmRelease.
type SourceRef struct {
	Kind      string
	Name      string
	Namespace string
}

// BoundSource resolves the source a Kustomization/HelmRelease reconciles from:
// spec.sourceRef for Kustomization, spec.chart.spec.sourceRef or spec.chartRef
// for HelmRelease. Namespace defaults to the resource's own namespace.
func BoundSource(u *unstructured.Unstructured) (SourceRef, bool) {
	get := func(path ...string) (kind, name, ns string, ok bool) {
		kind, _, _ = unstructured.NestedString(u.Object, append(path, "kind")...)
		name, _, _ = unstructured.NestedString(u.Object, append(path, "name")...)
		ns, _, _ = unstructured.NestedString(u.Object, append(path, "namespace")...)
		return kind, name, ns, name != ""
	}
	candidates := [][]string{
		{"spec", "sourceRef"},          // Kustomization
		{"spec", "chartRef"},           // HelmRelease (newer)
		{"spec", "chart", "spec", "sourceRef"}, // HelmRelease (chart template)
	}
	for _, p := range candidates {
		if kind, name, ns, ok := get(p...); ok {
			if ns == "" {
				ns = u.GetNamespace()
			}
			return SourceRef{Kind: kind, Name: name, Namespace: ns}, true
		}
	}
	return SourceRef{}, false
}
```

- [ ] **Step 4: Refactor the condition walk into `readyFromConditions` (shared)**

`common()` (lines ~82-117) currently inlines the Ready/Reconciling walk. Extract the shared logic so `ParseSource` and `common()` use one implementation. Add:
```go
// readyFromConditions derives the aggregate Ready state, the Ready condition's
// reason, and its message from status.conditions (Reconciling overrides Ready
// unless Ready is Failed). Shared by common() and ParseSource.
func readyFromConditions(u *unstructured.Unstructured) (ReadyState, string, string) {
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	state := Unknown
	reconciling := false
	var reason, message string
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
				state = Ready
			case "False":
				state = Failed
			}
			reason, _ = cm["reason"].(string)
			message, _ = cm["message"].(string)
		case "Reconciling":
			if cstatus == "True" {
				reconciling = true
			}
		}
	}
	if reconciling && state != Failed {
		state = Reconciling
	}
	return state, reason, message
}
```
Then rewrite `common()` to call it (keep the `lastTransitionTime` → `LastApplied` parse, which only `common()` needs):
```go
func common(u *unstructured.Unstructured, kind Kind) Resource {
	r := Resource{Kind: kind, Name: u.GetName(), Namespace: u.GetNamespace()}
	r.Suspended, _, _ = unstructured.NestedBool(u.Object, "spec", "suspend")
	r.SourceKind, _, _ = unstructured.NestedString(u.Object, "spec", "sourceRef", "kind")
	r.SourceName, _, _ = unstructured.NestedString(u.Object, "spec", "sourceRef", "name")
	r.Ready, r.Reason, r.Message = readyFromConditions(u)
	// lastTransitionTime of the Ready condition → LastApplied (only common needs it)
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, c := range conds {
		if cm, ok := c.(map[string]interface{}); ok {
			if t, _ := cm["type"].(string); t == "Ready" {
				if lt, ok := cm["lastTransitionTime"].(string); ok {
					if ts, err := time.Parse(time.RFC3339, lt); err == nil {
						r.LastApplied = ts
					}
				}
			}
		}
	}
	r.DependsOn = parseDependsOn(u)
	return r
}
```
(`Resource.Reason` and `Resource.DependsOn` are added in M10-c/M10-d Task 1; if implementing strictly a-then-c-then-d, add the `Reason` field now and stub `parseDependsOn` to return nil until M10-d. Recommended: land the `Resource` struct fields up front so `common()` compiles once.)

- [ ] **Step 5: Run test to verify it passes + existing parser tests**

Run: `go test ./internal/gitops/flux/ -v`
Expected: PASS (new source/bound tests + all existing `ParseKustomization`/`ParseHelmRelease`/`ParseDetail` tests still green after the `readyFromConditions` refactor).

- [ ] **Step 6: Commit**
```bash
git add internal/gitops/flux/flux.go internal/gitops/flux/source_test.go
git commit -m "$(printf 'feat: flux.ParseSource + BoundSource + shared readyFromConditions\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Watch the source kinds + expose them

**Files:**
- Modify: `internal/fleet/gitopswatch.go` (source informers, `GitOpsSources`, `GitOpsSourceObject`)
- Modify: `internal/fleet/gitopssource.go` (extend `sourceGVR` to all five kinds)
- Modify: `internal/fleet/conn.go` (extend `Conn` interface)
- Modify: `internal/fleet/registry_test.go` (`fakeConn` stubs)
- Test: `internal/fleet/gitopswatch_test.go`

- [ ] **Step 1: Extend `sourceGVR`** in `internal/fleet/gitopssource.go`:
```go
func sourceGVR(kind string) (group, fallbackVersion, resource string, ok bool) {
	switch kind {
	case "GitRepository":
		return "source.toolkit.fluxcd.io", "v1", "gitrepositories", true
	case "OCIRepository":
		return "source.toolkit.fluxcd.io", "v1beta2", "ocirepositories", true
	case "Bucket":
		return "source.toolkit.fluxcd.io", "v1", "buckets", true
	case "HelmRepository":
		return "source.toolkit.fluxcd.io", "v1", "helmrepositories", true
	case "HelmChart":
		return "source.toolkit.fluxcd.io", "v1", "helmcharts", true
	default:
		return "", "", "", false
	}
}
```

- [ ] **Step 2: Write the failing test** — append to `internal/fleet/gitopswatch_test.go`:
```go
func TestGitOpsSourcesReturnsWatchedSources(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset()
	scheme := runtime.NewScheme()
	gvrToListKind := map[schema.GroupVersionResource]string{
		{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}: "KustomizationList",
		{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}:        "HelmReleaseList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "gitrepositories"}:   "GitRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1beta2", Resource: "ocirepositories"}: "OCIRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "buckets"}:           "BucketList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "helmrepositories"}:  "HelmRepositoryList",
		{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "helmcharts"}:        "HelmChartList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToListKind, gitRepoUnstructured("flux-system"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, dyn, det, clock.Real{})
	c.ctx = ctx
	c.OpenGitOps()
	defer c.CloseGitOps()

	waitFor(t, 2*time.Second, func() bool {
		return len(c.GitOpsSources()) == 1
	})
	if _, ok := c.GitOpsSourceObject("GitRepository", "flux-system", "flux-system"); !ok {
		t.Fatal("expected GitOpsSourceObject to find the watched GitRepository")
	}
}
```
Add a `gitRepoUnstructured(name string) *unstructured.Unstructured` helper to the test file (a GitRepository in `flux-system` named `name`, with `status.artifact.revision` set), modelled on the existing `ksObj` helper.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestGitOpsSources -v`
Expected: FAIL - `GitOpsSources`/`GitOpsSourceObject` undefined.

- [ ] **Step 4: Add source informers to `gitopsWatch`** in `internal/fleet/gitopswatch.go`

Extend the `gitopsWatch` struct with a `srcInf map[flux.Kind]cache.SharedIndexInformer`. In `OpenGitOps`, after the ks/hr informers, build one informer per source kind:
```go
srcKinds := []struct {
	kind     flux.Kind
	group    string
	resource string
	fallback string
}{
	{flux.GitRepositoryKind, "source.toolkit.fluxcd.io", "gitrepositories", "v1"},
	{flux.OCIRepositoryKind, "source.toolkit.fluxcd.io", "ocirepositories", "v1beta2"},
	{flux.BucketKind, "source.toolkit.fluxcd.io", "buckets", "v1"},
	{flux.HelmRepositoryKind, "source.toolkit.fluxcd.io", "helmrepositories", "v1"},
	{flux.HelmChartKind, "source.toolkit.fluxcd.io", "helmcharts", "v1"},
}
srcInf := make(map[flux.Kind]cache.SharedIndexInformer, len(srcKinds))
for _, s := range srcKinds {
	ver := preferredVersion(c.typed.Discovery(), s.group, s.fallback)
	gvr := schema.GroupVersionResource{Group: s.group, Version: ver, Resource: s.resource}
	srcInf[s.kind] = factory.ForResource(gvr).Informer()
}
```
Store `srcInf` on the `gitopsWatch`. Then add:
```go
// GitOpsSources reads the source informer stores and parses them.
func (c *ClusterConn) GitOpsSources() []flux.Source {
	c.mu.RLock()
	g := c.gitops
	c.mu.RUnlock()
	if g == nil {
		return nil
	}
	var out []flux.Source
	for _, inf := range g.srcInf {
		for _, obj := range inf.GetStore().List() {
			if u, ok := obj.(*unstructured.Unstructured); ok {
				out = append(out, flux.ParseSource(u))
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Name < b.Name
	})
	return out
}

// GitOpsSourceObject returns a watched source object by kind/namespace/name.
func (c *ClusterConn) GitOpsSourceObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	c.mu.RLock()
	g := c.gitops
	c.mu.RUnlock()
	if g == nil {
		return nil, false
	}
	inf, ok := g.srcInf[flux.Kind(kind)]
	if !ok || inf == nil {
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

- [ ] **Step 5: Extend the `Conn` interface + `fakeConn`**

In `internal/fleet/conn.go` add to the `Conn` interface:
```go
	GitOpsSources() []flux.Source
	GitOpsSourceObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
```
In `internal/fleet/registry_test.go` add the `fakeConn` stubs (return `nil` / `nil,false`).

- [ ] **Step 6: Run tests + race**

Run: `go test ./internal/fleet/ -run 'TestGitOpsSources|TestOpenGitOps|TestGitOpsObject|TestRegistry' -v` then `go test -race ./internal/fleet/`
Expected: PASS, no race.

- [ ] **Step 7: Commit**
```bash
git add internal/fleet/gitopswatch.go internal/fleet/gitopssource.go internal/fleet/conn.go internal/fleet/registry_test.go internal/fleet/gitopswatch_test.go
git commit -m "$(printf 'feat: watch Flux source kinds; GitOpsSources + GitOpsSourceObject\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: appbridge — push sources + embed bound source in detail

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (`FluxSourceDTO`, `toSourceDTO`; extend `ResourceDetailDTO`)
- Modify: `internal/appbridge/gitops_service.go` (`GitOpsConn` gains source methods; push sources; embed source in `GetResourceDetail`)
- Modify: `internal/appbridge/gitops_service_test.go` (`fakeGitOpsConn` stubs)
- Test: `internal/appbridge/gitops_source_test.go`

- [ ] **Step 1: Write the failing test** — `internal/appbridge/gitops_source_test.go`:
```go
package appbridge

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToSourceDTO(t *testing.T) {
	dto := toSourceDTO(flux.Source{Kind: flux.GitRepositoryKind, Namespace: "flux-system", Name: "apps", Ready: flux.Failed, Reason: "GitOperationFailed", Revision: "main@sha1:abc", URL: "https://x/y"})
	if dto.Kind != "GitRepository" || dto.Ready != "Failed" || dto.Reason != "GitOperationFailed" {
		t.Fatalf("dto: %+v", dto)
	}
}

func TestGetResourceDetailEmbedsBoundSource(t *testing.T) {
	ks := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]interface{}{"name": "apps", "namespace": "flux-system"},
		"spec":     map[string]interface{}{"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"}},
		"status":   map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "False", "reason": "BuildFailed"}}},
	}}
	src := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1", "kind": "GitRepository",
		"metadata": map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status":   map[string]interface{}{"artifact": map[string]interface{}{"revision": "main@sha1:def"}, "conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}}},
	}}
	conn := &fakeGitOpsConn{obj: ks, srcObj: src}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, timeNowUTC, 0)
	dto := svc.GetResourceDetail("x", "Kustomization", "flux-system", "apps")
	if dto.Source == nil || dto.Source.Kind != "GitRepository" || dto.Source.Revision != "main@sha1:def" {
		t.Fatalf("embedded source: %+v", dto.Source)
	}
}
```

- [ ] **Step 2: Extend `fakeGitOpsConn`** in `internal/appbridge/gitops_service_test.go`

Add `srcObj *unstructured.Unstructured` to the struct and the stubs:
```go
func (f *fakeGitOpsConn) GitOpsSources() []flux.Source { return nil }
func (f *fakeGitOpsConn) GitOpsSourceObject(kind, ns, name string) (*unstructured.Unstructured, bool) {
	if f.srcObj == nil {
		return nil, false
	}
	return f.srcObj, true
}
```
(The `ReconcileWithSource` + `FluxEvents` stubs are added in M10-b/M10-e; if landing a-then-b sequentially, add no-op stubs now so the interface compiles, or land all stubs up front.)

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestToSourceDTO|TestGetResourceDetailEmbeds' -v`
Expected: FAIL - `FluxSourceDTO`/`toSourceDTO` undefined; `ResourceDetailDTO.Source` missing; `GitOpsConn` missing source methods.

- [ ] **Step 4: Implement the DTOs** in `internal/appbridge/gitops_dto.go`

Append `FluxSourceDTO` + `toSourceDTO`, and add `Source *FluxSourceDTO` (plus `Reason`, `DependsOn`, `Events` reserved for later sub-milestones) to `ResourceDetailDTO`:
```go
type FluxSourceDTO struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Ready     string `json:"ready"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Revision  string `json:"revision"`
	URL       string `json:"url"`
	Suspended bool   `json:"suspended"`
}

func toSourceDTO(s flux.Source) FluxSourceDTO {
	return FluxSourceDTO{
		Kind: string(s.Kind), Namespace: s.Namespace, Name: s.Name,
		Ready: string(s.Ready), Reason: s.Reason, Message: s.Message,
		Revision: s.Revision, URL: s.URL, Suspended: s.Suspended,
	}
}
```
Add `Source *FluxSourceDTO `json:"source"`` to `ResourceDetailDTO`.

- [ ] **Step 5: Wire `GitOpsConn` + `GetResourceDetail` + the push** in `internal/appbridge/gitops_service.go`

Add to the `GitOpsConn` interface:
```go
	GitOpsSources() []flux.Source
	GitOpsSourceObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
```
Extend the push payload + loop:
```go
type gitOpsPayload struct {
	Cluster   string            `json:"cluster"`
	Resources []FluxResourceDTO `json:"resources"`
	Sources   []FluxSourceDTO   `json:"sources"`
}
```
In `pushLoop`, build `sources` from `conn.GitOpsSources()` (map each via `toSourceDTO`) and include them in the emitted payload. In `GetResourceDetail`, after building the base DTO, resolve + embed the bound source:
```go
d := toDetailDTO(flux.ParseDetail(u))
if ref, ok := flux.BoundSource(u); ok {
	if su, ok := conn.GitOpsSourceObject(ref.Kind, ref.Namespace, ref.Name); ok {
		src := toSourceDTO(flux.ParseSource(su))
		d.Source = &src
	}
}
return d
```

- [ ] **Step 6: Run tests + race**

Run: `go test ./internal/appbridge/ -race -v`
Expected: PASS, no race.

- [ ] **Step 7: Commit**
```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_service.go internal/appbridge/gitops_service_test.go internal/appbridge/gitops_source_test.go
git commit -m "$(printf 'feat: appbridge push Flux sources + embed bound source in detail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Frontend — sources in store/bridge + render bound-source + sources filter

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts` (types + gitops slice `sources` + `setGitOps` signature)
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts` (store sources from the push)
- Modify: `cmd/klyx/frontend/src/cluster/GitOps.tsx` (Source section in panel + sources filter)
- Test: `cmd/klyx/frontend/src/store/gitops.test.ts`, `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`

- [ ] **Step 1: Store** — add the types + extend the slice in `store/fleet.ts`:
```ts
export type FluxSourceDTO = { kind: string; namespace: string; name: string; ready: string; reason: string; message: string; revision: string; url: string; suspended: boolean };
```
Add `source?: FluxSourceDTO | null` to `ResourceDetailDTO`. Add `sources: FluxSourceDTO[]` to `GitOpsSlice`, default `[]`, and change `setGitOps` to `(cluster, resources, sources)`. Update `clearGitOps`/initial value accordingly. Update the failing store test to pass `sources`.

- [ ] **Step 2: Bridge** — in `bridge/gitops.ts`, widen the event payload to `{ cluster, resources, sources }` and call `setGitOps(cluster, d.resources ?? [], d.sources ?? [])`.

- [ ] **Step 3: View** — in `GitOps.tsx`:
  - Add a `"sources"` member to `FluxFilter` and a `FilterButton label="sources"` (count = `gitops.sources.length`). When active, render the sources list (a `SourceRow` mirroring `RowSummary`: kind chip `git`/`oci`/`bucket`/`helmrepo`/`chart`, `shortRev(revision)`, Ready colour from `readyColor`, message when not Ready).
  - In `DetailPanel`, add a **Source** `Section` rendered from `detail.source`: a status dot (`readyColor[detail.source.ready]`), `kind/namespace/name`, `shortRev(revision)`, and the message. When `detail.source.ready !== "Ready"`, render it first and in danger styling ("source not ready: `<reason>`") - this is the headline for a stuck resource.

- [ ] **Step 4: Tests** — extend `GitOps.test.tsx`: a detail with a failing `source` renders "source not ready"; the sources filter shows a source row. Extend the bridge/store test for the 3-arg `setGitOps`.

- [ ] **Step 5: Build + commit**
Run: `cd cmd/klyx/frontend && npx vitest run && npm run build`
```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/bridge/gitops.ts cmd/klyx/frontend/src/cluster/GitOps.tsx cmd/klyx/frontend/src/store/gitops.test.ts cmd/klyx/frontend/src/cluster/GitOps.test.tsx
git commit -m "$(printf 'feat: render Flux source health + sources filter\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# M10-b — Reconcile with source

### Task 1: `ClusterConn.ReconcileWithSource`

**Files:**
- Modify: `internal/fleet/gitopsactions.go`
- Modify: `internal/fleet/conn.go` (+`fakeConn`)
- Test: `internal/fleet/gitopsactions_test.go`

- [ ] **Step 1: Write the failing test** — seed the dynamic fake with a Kustomization (sourceRef → a GitRepository) and the GitRepository; call `ReconcileWithSource`; assert the `reconcile.fluxcd.io/requestedAt` annotation is present on BOTH objects afterwards. Add a second case: a resource whose source can't be found still patches the resource (degrades to plain reconcile) and returns no error.

- [ ] **Step 2: Implement** in `internal/fleet/gitopsactions.go`:
```go
// ReconcileWithSource stamps the reconcile annotation on the resource AND its
// bound source (flux reconcile --with-source). Degrades to a plain resource
// reconcile when the source can't be resolved, so it never hard-fails.
func (c *ClusterConn) ReconcileWithSource(ctx context.Context, kind, ns, name string) error {
	u, ok := c.GitOpsObject(kind, ns, name)
	if ok {
		if ref, ok := flux.BoundSource(u); ok {
			if sgroup, fallback, resource, ok := sourceGVR(ref.Kind); ok {
				ver := preferredVersion(c.typed.Discovery(), sgroup, fallback)
				sgvr := schema.GroupVersionResource{Group: sgroup, Version: ver, Resource: resource}
				body := flux.ReconcilePatch(c.clk.Now())
				// Best-effort: a source patch failure must not block the resource reconcile.
				_, _ = c.dyn.Resource(sgvr).Namespace(ref.Namespace).Patch(ctx, ref.Name, types.MergePatchType, body, metav1.PatchOptions{})
			}
		}
	}
	return c.Reconcile(ctx, kind, ns, name)
}
```
Add `ReconcileWithSource(ctx context.Context, kind, ns, name string) error` to the `Conn` interface + the `fakeConn` stub.

- [ ] **Step 3: Run tests + race; commit**
```bash
git add internal/fleet/gitopsactions.go internal/fleet/conn.go internal/fleet/registry_test.go internal/fleet/gitopsactions_test.go
git commit -m "$(printf 'feat: ReconcileWithSource - reconcile resource + bound source\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 2: appbridge `ReconcileWithSource` + frontend button

**Files:**
- Modify: `internal/appbridge/gitops_service.go` (+interface, +bound method), `gitops_service_test.go`
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts`, `cmd/klyx/frontend/src/cluster/GitOps.tsx`

- [ ] **Step 1:** Add `ReconcileWithSource(ctx, kind, ns, name) error` to the appbridge `GitOpsConn` interface (+`fakeGitOpsConn` stub), and the bound method mirroring `Reconcile` exactly (timeout, `ActionResultDTO`).
- [ ] **Step 2:** Bridge `reconcileWithSource(...)` mirroring `reconcile`, success toast "Reconcile (with source) requested for `<ns>/<name>`".
- [ ] **Step 3:** In `GitOps.tsx` add a "Reconcile with source" button next to "Reconcile" in `DetailPanel`, routed through the existing `pending` ConfirmDialog (new verb `"reconcile-source"`; prd-lock aware; confirm label "Reconcile + source").
- [ ] **Step 4:** Tests: the button opens the confirm and the bridge is called. Build + commit.
```bash
git commit -m "$(printf 'feat: Reconcile with source day-2 action in GitOps view\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# M10-c — Failure-reason surfacing

### Task 1: Carry `Reason` through the resource DTO + render it

**Files:**
- Modify: `internal/gitops/flux/flux.go` (add `Reason` to `Resource` - already populated by `readyFromConditions` in M10-a Task 1)
- Modify: `internal/appbridge/gitops_dto.go` (`FluxResourceDTO.Reason`, `ResourceDetailDTO.Reason`, set in `ToFluxDTO`/`toDetailDTO`)
- Modify: `cmd/klyx/frontend/src/store/fleet.ts` (`reason` on both DTO types)
- Modify: `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Tests: appbridge DTO test, `GitOps.test.tsx`

- [ ] **Step 1:** Add `Reason string` to `flux.Resource` and to `flux.Detail` (populate `Detail.Reason` from the Ready condition in `ParseDetail`). Add `Reason` to `FluxResourceDTO` + `ResourceDetailDTO` and set in `ToFluxDTO`/`toDetailDTO`. Unit-test: a `Failed` resource with reason `UpgradeFailed` → DTO carries it.
- [ ] **Step 2:** Frontend types gain `reason: string`. In `RowSummary`, when `needsAttention(r) && r.reason`, render a small mono chip (the reason) next to the `ks`/`hr` tag (danger tint when `ready === "Failed"`, warning otherwise). In `InspectorHeader`, show the reason chip beside the status word.
- [ ] **Step 3:** Tests: a `Failed` row renders its reason chip. Build + commit.
```bash
git commit -m "$(printf 'feat: surface Flux Ready-condition reason on row + inspector\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# M10-d — dependsOn blocked-by

### Task 1: Parse `spec.dependsOn`

**Files:**
- Modify: `internal/gitops/flux/flux.go` (`DependencyRef`, `parseDependsOn`, fields on `Resource`+`Detail`)
- Test: `internal/gitops/flux/flux_test.go` (or `detail_test.go`)

- [ ] **Step 1: Write the failing test** — a ks with `spec.dependsOn: [{name: infra}, {name: db, namespace: data}]` in namespace `flux-system` → `DependsOn == [{flux-system, infra}, {data, db}]`.
- [ ] **Step 2: Implement:**
```go
type DependencyRef struct {
	Namespace string
	Name      string
}

// parseDependsOn reads spec.dependsOn; namespace defaults to the object's own.
func parseDependsOn(u *unstructured.Unstructured) []DependencyRef {
	raw, _, _ := unstructured.NestedSlice(u.Object, "spec", "dependsOn")
	var out []DependencyRef
	for _, e := range raw {
		em, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := em["name"].(string)
		if name == "" {
			continue
		}
		ns, _ := em["namespace"].(string)
		if ns == "" {
			ns = u.GetNamespace()
		}
		out = append(out, DependencyRef{Namespace: ns, Name: name})
	}
	return out
}
```
Add `DependsOn []DependencyRef` to `Resource` (set in `common()`) and `Detail` (set in `ParseDetail`). Commit.

### Task 2: DTO + frontend blocked-by

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (`DependencyRefDTO`; `DependsOn` on `FluxResourceDTO`+`ResourceDetailDTO`)
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Tests: appbridge + `GitOps.test.tsx`

- [ ] **Step 1:** `DependencyRefDTO{Namespace,Name}` (json `namespace`/`name`); map `DependsOn` in `ToFluxDTO`/`toDetailDTO`. Frontend `DependencyRefDTO` type + `dependsOn` on both DTO types.
- [ ] **Step 2:** In `DetailPanel`, a **Depends on** `Section`: for each dep, resolve its Ready state from `gitops.resources` (match a Kustomization/HelmRelease by `namespace/name`) and render a status dot + `namespace/name` + resolved state (or "not found" muted). When `detail.reason === "DependencyNotReady"`, render a danger headline "blocked by `<first not-ready dep>`" above the section.
  - Pass the resolved-state helper the resource list: `GitOps.tsx` already has `rows` in scope; compute a `Map` of `keyByNsName → ready` and thread it into `DetailPanel`.
- [ ] **Step 3:** Tests: a resource with `reason: DependencyNotReady` + one not-ready dep renders the blocked-by line. Build + commit.
```bash
git commit -m "$(printf 'feat: Flux dependsOn chain with blocked-by resolution\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# M10-e — Drift surface (read Flux's telemetry)

> This is the **default** drift view (spec §1.1): Flux heals drift each reconcile, so the truthful, zero-credential drift signal is the controller's own record (Events naming corrected objects) + conditions + the inventory we already parse - not a Git diff. A real diff is the on-demand M10-f escape hatch.

### Task 1: `ClusterConn.FluxEvents`

**Files:**
- Modify: `internal/gitops/flux/flux.go` (an `Event` type, optional) or reuse a fleet event type
- Modify: `internal/fleet/gitopswatch.go` or a new `internal/fleet/gitopsevents.go`
- Modify: `internal/fleet/conn.go` (+`fakeConn`)
- Test: `internal/fleet/gitopsevents_test.go`

- [ ] **Step 1:** Inspect `internal/fleet/events.go` + `internal/workloads/events.go` for the existing event read/parse pattern and reuse it. Define the return type as `[]flux.Event` (`Type, Reason, Message string; Count int; Age time.Duration` - or carry a timestamp and let the DTO compute age, matching how `events.go` does it).
- [ ] **Step 2: Write the failing test** — seed the typed fake with two core/v1 Events whose `involvedObject` matches a Kustomization (`kind=Kustomization, name=apps, namespace=flux-system`) and one that does not → `FluxEvents` returns the two, newest first, capped at 25.
- [ ] **Step 3: Implement** `FluxEvents(ctx, kind, ns, name)` — list events in `ns` (field-selector on `involvedObject.name` where supported, else list+filter), keep those whose `involvedObject.kind == kind && name == name`, sort newest-first by `lastTimestamp`/`eventTime`, cap. Add to the `Conn` interface + `fakeConn`. Commit.

### Task 2: appbridge + frontend timeline

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (`FluxEventDTO`, `Events` on `ResourceDetailDTO`)
- Modify: `internal/appbridge/gitops_service.go` (`GitOpsConn.FluxEvents`; call it in `GetResourceDetail`), `gitops_service_test.go`
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Tests: appbridge + `GitOps.test.tsx`

- [ ] **Step 1:** `FluxEventDTO{Type,Reason,Message,Age string; CountInt int}` (`Age` humanized server-side via the service `now()` like `ToFluxDTO` does; or carry unix + humanize client-side - match the codebase's existing convention from `events.go`). Add `Events []FluxEventDTO` to `ResourceDetailDTO`. Add `FluxEvents` to the `GitOpsConn` interface + fake; call it in `GetResourceDetail` and map the results.
- [ ] **Step 2:** Frontend `FluxEventDTO` type + `events` on `ResourceDetailDTO`. In `DetailPanel`, a **Drift / events** `Section`: each row `<reason> · <age>` + message, `type === "Warning"` in danger colour; flag drift corrections (reason/message indicating an object was reconfigured) as the drift signal with a marker, cross-referenced to the inventory. Empty → muted "no recent events".
- [ ] **Step 3:** Tests: a detail with a Warning event renders it in danger styling; a drift-correction event is flagged. Build + commit.
```bash
git commit -m "$(printf 'feat: Flux drift surface - reconciliation event timeline in detail panel\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# M10-f — On-demand `flux diff` escape hatch

> Scoped to **suspended / apply-failing** resources only (the cases where a real diff shows what telemetry cannot). A shell-out to the `flux` CLI - which already handles SOPS via age/GPG + AWS/Azure/GCP KMS using the shell's per-cloud auth, covering the whole four-provider matrix with no provider code in Klyx. User-triggered, never auto-run; hidden when `flux` is absent.

### Task 1: `internal/fluxcli` wrapper

**Files:**
- New: `internal/fluxcli/fluxcli.go`, `internal/fluxcli/fluxcli_test.go`

- [ ] **Step 1:** Inspect `internal/helmcli/` for the existing CLI-wrapper pattern (exec seam, `internal/execenv` PATH resolution, fake-exec tests) and mirror it. Define:
```go
func Available() bool // `flux` resolvable on PATH (via execenv)

type DiffResult struct {
	Output     string
	HasChanges bool
	Err        string
}

// DiffKustomization runs `flux diff kustomization <name> -n <ns> --path <path>`
// against the given kubeconfig/context. flux exits non-zero WITH diff output when
// there are changes; distinguish that from a real failure (empty output + error).
func DiffKustomization(ctx context.Context, kubeconfig, kubeContext, ns, name, path string) DiffResult
```
- [ ] **Step 2:** Write fake-exec tests: a run that returns changes (non-zero + diff text) → `HasChanges true, Err ""`; a clean run (zero, no output) → `HasChanges false`; a hard failure (e.g. "flux: command not found" / decrypt denied) → `Err` populated, `HasChanges false`. `Available()` true/false via the fake PATH resolver.
- [ ] **Step 3:** Implement against the exec seam; honour `ctx` cancellation/timeout (diff can clone). Commit.
```bash
git commit -m "$(printf 'feat: internal/fluxcli wrapper around flux diff kustomization\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 2: `ClusterConn.FluxDiffKustomization` (gated)

**Files:**
- New: `internal/fleet/gitopsdiff.go`, `internal/fleet/gitopsdiff_test.go`
- Modify: `internal/fleet/conn.go` (+`fakeConn`)

- [ ] **Step 1: Write the failing test** — seed the gitops watch with a *suspended* Kustomization carrying `spec.path: ./apps` + a bound source; assert `FluxDiffKustomization` reads the path and calls the (injected) fluxcli seam with the right args. A second case: a *healthy, non-suspended, Ready* Kustomization → returns a refusal error without shelling out (the gate).
- [ ] **Step 2: Implement:**
```go
// FluxDiffKustomization runs an on-demand `flux diff` for a Kustomization. Gated:
// only suspended or apply-failing (Ready=False) resources - a diff on a healthy
// auto-reconciling Kustomization is empty/misleading. Shells out via fluxcli,
// which inherits the shell's per-cloud auth for SOPS/KMS across providers.
func (c *ClusterConn) FluxDiffKustomization(ctx context.Context, ns, name string) (fluxcli.DiffResult, error) {
	u, ok := c.GitOpsObject(string(flux.KustomizationKind), ns, name)
	if !ok {
		return fluxcli.DiffResult{}, fmt.Errorf("kustomization %s/%s not found", ns, name)
	}
	r := flux.ParseKustomization(u)
	if !r.Suspended && r.Ready != flux.Failed {
		return fluxcli.DiffResult{}, fmt.Errorf("diff only available for suspended or failing Kustomizations")
	}
	path, _, _ := unstructured.NestedString(u.Object, "spec", "path")
	return c.fluxcli.DiffKustomization(ctx, c.kubeconfigPath, c.kubeContext, ns, name, path), nil
}
```
(Thread the `fluxcli` seam + the cluster's `kubeconfigPath`/`kubeContext` onto `ClusterConn` - read them from the `config.ClusterConfig` the conn was built from. Add `FluxDiffKustomization` to the `Conn` interface + `fakeConn`.)
- [ ] **Step 3:** Tests + race; commit.
```bash
git commit -m "$(printf 'feat: ClusterConn.FluxDiffKustomization - gated on-demand flux diff\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

### Task 3: appbridge `FluxDiff` + frontend "compute diff"

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (`FluxDiffDTO`), `gitops_service.go` (+interface, +bound method), `gitops_service_test.go`
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts`, `cmd/klyx/frontend/src/cluster/GitOps.tsx`, `store/fleet.ts`
- Tests: appbridge + `GitOps.test.tsx`

- [ ] **Step 1:** `FluxDiffDTO{ Available, HasChanges bool; Output, Error string }`. Add `FluxDiffKustomization` + an `FluxAvailable() bool` to the appbridge `GitOpsConn` interface (+fake). Bound method `FluxDiff(cluster, ns, name) FluxDiffDTO`: cluster-miss → `{Error}`; `Available:false` when `flux` absent; else run + map the `DiffResult`.
- [ ] **Step 2:** Bridge `fluxDiff(cluster, ns, name): Promise<FluxDiffDTO>`; store a `diff` slot on the gitops detail slice (or local component state) keyed to the open resource.
- [ ] **Step 3:** In `GitOps.tsx` `DetailPanel`, render a **Compute diff** button **only** when `resource.suspended || resource.ready === "Failed"`. Click → `fluxDiff` → render `output` inline (mono, +/- line colouring) or "no changes"; hide the button when a probed `available` is false; on `error` show the CLI message. A small caption: "shells out to `flux diff` using your local credentials".
- [ ] **Step 4:** Tests: the button appears only for suspended/failing resources; clicking renders the diff output; an unavailable result hides it. Build + commit.
```bash
git commit -m "$(printf 'feat: on-demand flux diff for suspended/failing Kustomizations\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---
---

# Final verification + native handoff

- [ ] **Step 1: Full Go suite + race + vet**

Run: `make test && make vet && go test -race ./internal/...`
Expected: all pass, vet clean, no race.

- [ ] **Step 2: Frontend suite + build + binding regen**

Run: `cd cmd/klyx/frontend && npx vitest run && npm run build`. Then from `cmd/klyx`: `PATH="$HOME/go/bin:$PATH" wails3 build 2>&1 | tail -10` to regenerate the `GitOpsService` binding (new `ReconcileWithSource`, `FluxDiff`; extended `GetResourceDetail` / `gitops:updated` payload) and confirm the whole app builds.
Expected: tests pass; both builds clean; generated `gitopsservice.ts` includes `ReconcileWithSource` + `FluxDiff`.

- [ ] **Step 3: Native handoff**

```
cd cmd/klyx && export PATH="$HOME/go/bin:$PATH" && KLYX_CONFIG="$HOME/.config/klyx/fleet.yaml" wails3 dev
# Drill homelab-nelli (and an AKS/EKS/GKE cluster) -> Flux:
#  - the "sources" filter lists GitRepository/OCIRepository/... with fetched revision + Ready
#  - expand a Kustomization: Source section shows the bound source's health (a failing
#    source is the headline); a reason chip shows on failing rows; "Depends on" lists
#    deps with resolved state (blocked-by when DependencyNotReady); the Drift/events
#    section shows the controller's record (drift corrections, health-check failures)
#  - "Reconcile with source" re-pulls the source + the resource
#  - on a SUSPENDED Kustomization, "Compute diff" appears -> shells out to `flux diff`
#    and shows a real diff (verifies SOPS decrypts via your local cloud identity);
#    on a healthy resource the button is absent (gated)
# Owner eyeball confirms across providers: homelab age/GPG decrypt + at least one cloud
# KMS (AKS/Key Vault), and Cilium HelmRelease via OCIRepository for chartRef BoundSource.
```

---

## Self-Review

**Spec coverage:**
- §3.1 `Source`/`ParseSource`/`BoundSource`/`readyFromConditions`, `Resource.Reason`, `Resource.DependsOn`/`DependencyRef` → M10-a T1, M10-c T1, M10-d T1. ✓
- §3.2 source informers, `GitOpsSources`/`GitOpsSourceObject`, `ReconcileWithSource`, `FluxEvents`, extended `sourceGVR` → M10-a T2, M10-b T1, M10-e T1. ✓
- §3.3 `internal/fluxcli` wrapper + gated `ClusterConn.FluxDiffKustomization` (suspended/failing only) → M10-f T1, T2. ✓
- §4 `FluxSourceDTO`/`toSourceDTO`, extended `ResourceDetailDTO` (Source/Reason/DependsOn/Events), pushed `sources`, `GetResourceDetail` embeds source+events, `ReconcileWithSource` + `FluxDiff` bound methods → M10-a T3, M10-b T2, M10-c T1, M10-d T2, M10-e T2, M10-f T3. ✓
- §5 store `sources` + `setGitOps` 3-arg, bridge handler, Source section, sources filter, reason chip, dependsOn blocked-by, drift/events surface, "Reconcile with source" + gated "Compute diff" buttons → M10-a T4, M10-b T2, M10-c T2, M10-d T2, M10-e T2, M10-f T3. ✓
- §6 tests across flux/fleet/fluxcli/appbridge/frontend + native handoff → every task + final. ✓
- No `main.go` change (no new service; methods bind on rebuild) — final Step 2 regenerates the binding. ✓

**Drift design (spec §1.1 / decisions 6-9):** M10-e (telemetry read) is the default, zero-credential, multi-cloud-for-free drift surface; M10-f (`flux diff` shell-out) is on-demand and **gated to suspended/failing Kustomizations** so the SOPS/KMS/multi-cloud path is never on the hot path. No native Git-render engine; no HelmRelease diff. The gate is enforced backend-side (`FluxDiffKustomization` refuses) *and* the button is hidden frontend-side - defence in depth.

**Interface consistency:** the `Conn` interface (fleet) and `GitOpsConn` interface (appbridge) both gain `GitOpsSources`/`GitOpsSourceObject`/`ReconcileWithSource`/`FluxEvents`; `fakeConn` (registry_test) and `fakeGitOpsConn` (gitops_service_test) gain matching stubs - land all stubs up front (M10-a T2/T3) so each sub-milestone compiles in isolation. `ReadyState` is reused for `Source.Ready` (no new enum). `BoundSource` (T1, M10-a) is consumed by `GetResourceDetail` (M10-a T3) and `ReconcileWithSource` (M10-b T1). `sourceGVR` (extended M10-a T2) is consumed by `ReconcileWithSource` (M10-b T1) and the existing `SourceURL`.

**DTO ↔ TS consistency:** `FluxSourceDTO` Go json (kind/namespace/name/ready/reason/message/revision/url/suspended) matches the TS `FluxSourceDTO`. `ResourceDetailDTO` additive fields (source/reason/dependsOn/events) match the TS `ResourceDetailDTO`. `FluxResourceDTO` additive fields (reason/dependsOn) match the TS type and the `gitops:updated` payload (`{cluster, resources, sources}`) matches the bridge handler + 3-arg `setGitOps`.

**Placeholder scan:** none. The novel/precision code (parsers, informers, actions, DTOs) is given in full; the repetitive frontend rows + appbridge mirror methods follow the M3-b patterns already in the named files and are specified field-by-field.

**Non-goal check:** every M10 capability is read (sources, reason, dependsOn, events) or day-2-drive (reconcile-with-source = the same annotation stamp the existing Reconcile uses). Nothing authors desired state. Image-automation + notification-controller explicitly excluded (spec §2, decision 7).
