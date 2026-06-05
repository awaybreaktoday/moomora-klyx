# M4-a: CRD Browser (grouped by API group) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-cluster custom-resource browser in the cluster's Resources section: CRDs grouped by API group with scope, owning-operator attribution, category badges, and lazy hybrid (exact under 500, `500+` above) instance counts.

**Architecture:** Approach A from the spec - one dynamic `customresourcedefinitions` list defines the tree (cheap, carries labels); counts are lazy per-kind metadata-only lists fired on group-expand. Pure request/response, NO informer (avoids the Cilium memory trap). Pure logic (parse, attribution, count-display) lives in a new `internal/crd` package; `ClusterConn` gains two read methods; a new bound `CRDService` shapes DTOs; a React `CRDBrowser` renders.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic fake for the CRD list, metadata fake for counts), Wails v3 bound services, React 19 + TS 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **Data source:** `ClusterConn` already holds `dyn dynamic.Interface` and `meta metadata.Interface`. The CRD list uses `dyn` on `{apiextensions.k8s.io, v1, customresourcedefinitions}`; counts use `meta` (metadata-only, lightweight). The existing `preferredVersion` helper is NOT needed here - the CRD object itself tells us each kind's storage version.
- **No count endpoint in k8s:** to show a number you must list. Counts are therefore lazy (only on group-expand), capped at 500 via `ListOptions{Limit}`, and one-shot (never watched).
- **Metadata fake seeding (verified):** `metadatafake.NewSimpleMetadataClient(scheme, objs...)` where each obj is a `*metav1.PartialObjectMetadata` with `TypeMeta{APIVersion: "<group>/<version>", Kind: "<Kind>"}`. List with the regular plural GVR resolves them (the fake guesses plural from kind). Call `_ = metav1.AddMetaToScheme(scheme)` after `NewTestScheme()`.
- **Dynamic fake (CRD list):** `dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[GVR]string{crdGVR: "CustomResourceDefinitionList"}, crdObjs...)` - same pattern as the gitops-watch tests.
- **Request/response, not push:** `CRDService` has no emitter/tick. It mirrors `GetResourceDetail`/`ResolveGitLink` (bound methods returning DTOs).
- **Wire points:** `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx:24` currently returns `<Placeholder .../>` for non-overview/gitops sections - swap in `<CRDBrowser .../>` for `resources`. `cmd/klyx/main.go:66-69` registers services in the `Services:` slice; add `CRDService` the same way as `gitopsSvc` (it uses `reg.Conn(name)`).
- **The fleet `Conn` interface** (`internal/fleet/conn.go`) is implemented by `ClusterConn` and stubbed by `fakeConn` (`registry_test.go`). Both gain the two new methods.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/crd/crd.go` | `Info`, `ParseCRD`, `Cap`, `CountDisplay`, `crdGVR` | Create |
| `internal/crd/attribution.go` | `Operator`, `Category` | Create |
| `internal/crd/crd_test.go` | parse + count-display tests | Create |
| `internal/crd/attribution_test.go` | operator + category tests | Create |
| `internal/fleet/crd.go` | `ClusterConn.ListCRDs` + `CountResource` | Create |
| `internal/fleet/crd_test.go` | dynamic-fake list + metadata-fake count | Create |
| `internal/fleet/conn.go` | add 2 methods to `Conn` interface | Modify |
| `internal/fleet/registry_test.go` | `fakeConn` stubs | Modify |
| `internal/appbridge/crd_dto.go` | DTOs + grouping/sort | Create |
| `internal/appbridge/crd_service.go` | `CRDService` + `CRDConn` | Create |
| `internal/appbridge/crd_service_test.go` | grouping/attribution/count tests | Create |
| `cmd/klyx/main.go` | register `CRDService` | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | `crd` slice + types | Modify |
| `cmd/klyx/frontend/src/bridge/crd.ts` | `listCRDs` / `countKind` | Create |
| `cmd/klyx/frontend/src/cluster/CRDBrowser.tsx` | the view | Create |
| `cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx` | render/reshape/count/search tests | Create |
| `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx` | render CRDBrowser for `resources` | Modify |

---

## Task 1: Pure `internal/crd` package

**Files:**
- Create: `internal/crd/crd.go`, `internal/crd/attribution.go`
- Test: `internal/crd/crd_test.go`, `internal/crd/attribution_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/crd/crd_test.go`:

```go
package crd

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func crdObj(group, kind, plural, scope string, shortNames []string, versions []interface{}, labels map[string]interface{}) *unstructured.Unstructured {
	sn := make([]interface{}, len(shortNames))
	for i, s := range shortNames {
		sn[i] = s
	}
	meta := map[string]interface{}{"name": plural + "." + group}
	if labels != nil {
		meta["labels"] = labels
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   meta,
		"spec": map[string]interface{}{
			"group": group,
			"names": map[string]interface{}{"kind": kind, "plural": plural, "shortNames": sn},
			"scope": scope,
			"versions": versions,
		},
	}}
}

func TestParseCRDNamespacedWithShortNames(t *testing.T) {
	u := crdObj("cilium.io", "CiliumEndpoint", "ciliumendpoints", "Namespaced",
		[]string{"cep", "ciliumep"},
		[]interface{}{map[string]interface{}{"name": "v2", "served": true, "storage": true}},
		map[string]interface{}{"app.kubernetes.io/part-of": "cilium"})
	got, ok := ParseCRD(u)
	if !ok {
		t.Fatal("want ok")
	}
	if got.Group != "cilium.io" || got.Kind != "CiliumEndpoint" || got.Plural != "ciliumendpoints" {
		t.Fatalf("ids: %+v", got)
	}
	if got.Scope != "Namespaced" || got.Version != "v2" {
		t.Fatalf("scope/version: %+v", got)
	}
	if len(got.ShortNames) != 2 || got.ShortNames[0] != "cep" {
		t.Fatalf("shortNames: %+v", got.ShortNames)
	}
	if got.Operator != "cilium" {
		t.Fatalf("operator: %q", got.Operator)
	}
}

func TestParseCRDStorageVersionPick(t *testing.T) {
	// v1beta1 served-not-storage, v1 served+storage -> pick v1.
	u := crdObj("example.com", "Widget", "widgets", "Cluster", nil, []interface{}{
		map[string]interface{}{"name": "v1beta1", "served": true, "storage": false},
		map[string]interface{}{"name": "v1", "served": true, "storage": true},
	}, nil)
	got, ok := ParseCRD(u)
	if !ok || got.Version != "v1" || got.Scope != "Cluster" {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestParseCRDServedFallbackWhenNoStorage(t *testing.T) {
	u := crdObj("example.com", "Widget", "widgets", "Namespaced", nil, []interface{}{
		map[string]interface{}{"name": "v1alpha1", "served": true, "storage": false},
	}, nil)
	if got, _ := ParseCRD(u); got.Version != "v1alpha1" {
		t.Fatalf("want served fallback v1alpha1, got %q", got.Version)
	}
}

func TestParseCRDRejectsMissingNames(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"spec": map[string]interface{}{"group": "example.com"},
	}}
	if _, ok := ParseCRD(u); ok {
		t.Fatal("want ok=false for missing kind/plural")
	}
}

func TestCountDisplay(t *testing.T) {
	if n, capped := CountDisplay(3, ""); n != 3 || capped {
		t.Fatalf("uncapped: %d %v", n, capped)
	}
	if n, capped := CountDisplay(Cap, "more"); n != Cap || !capped {
		t.Fatalf("capped: %d %v", n, capped)
	}
}
```

Create `internal/crd/attribution_test.go`:

```go
package crd

import "testing"

func TestOperatorPriority(t *testing.T) {
	// name beats part-of beats chart beats managed-by.
	if got := Operator(map[string]string{"app.kubernetes.io/name": "envoy-gateway", "app.kubernetes.io/managed-by": "Helm"}); got != "envoy-gateway" {
		t.Fatalf("name priority: %q", got)
	}
	if got := Operator(map[string]string{"app.kubernetes.io/part-of": "cilium"}); got != "cilium" {
		t.Fatalf("part-of: %q", got)
	}
	if got := Operator(map[string]string{"helm.sh/chart": "cert-manager-v1.14.2"}); got != "cert-manager" {
		t.Fatalf("chart version strip: %q", got)
	}
	if got := Operator(map[string]string{"app.kubernetes.io/managed-by": "flux"}); got != "flux" {
		t.Fatalf("managed-by: %q", got)
	}
	if got := Operator(map[string]string{"unrelated": "x"}); got != "" {
		t.Fatalf("unknown -> empty, got %q", got)
	}
}

func TestCategory(t *testing.T) {
	cases := map[string]string{
		"cilium.io":                   "CNI",
		"source.toolkit.fluxcd.io":    "GITOPS",
		"argoproj.io":                 "GITOPS",
		"cert-manager.io":             "PKI",
		"gateway.networking.k8s.io":   "NETWORK",
		"gateway.envoyproxy.io":       "NETWORK",
		"external-secrets.io":         "SECRETS",
		"monitoring.coreos.com":       "OBSERV",
		"postgresql.cnpg.io":          "DATABASE",
		"unknown.example.com":         "",
	}
	for group, want := range cases {
		if got := Category(group); got != want {
			t.Fatalf("Category(%q)=%q want %q", group, got, want)
		}
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/crd/ -v`
Expected: FAIL - package/functions undefined.

- [ ] **Step 3: Implement `internal/crd/crd.go`**

```go
// Package crd parses CustomResourceDefinition objects (read as unstructured) into
// a vocabulary-correct model, with best-effort operator/category attribution and
// a hybrid instance-count display. No apiextensions Go API dependency: tolerant
// of version drift.
package crd

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GVR is the dynamic resource for listing CRDs.
var GVR = schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}

// Cap bounds an instance count: a single metadata list page of this size. A full
// page plus a continue token means "more than Cap", rendered as "<Cap>+".
const Cap = 500

// Info is a parsed CRD: identity, scope, the version to count against, and a
// best-effort owning operator.
type Info struct {
	Group      string
	Kind       string
	Plural     string
	ShortNames []string
	Scope      string // "Namespaced" | "Cluster"
	Version    string // storage (else first served, else first) version
	Operator   string // best-effort from metadata.labels; "" when unknown
}

// ParseCRD maps a CRD unstructured to Info. ok=false when group/kind/plural are
// missing (an object we cannot meaningfully browse).
func ParseCRD(u *unstructured.Unstructured) (Info, bool) {
	group, _, _ := unstructured.NestedString(u.Object, "spec", "group")
	kind, _, _ := unstructured.NestedString(u.Object, "spec", "names", "kind")
	plural, _, _ := unstructured.NestedString(u.Object, "spec", "names", "plural")
	if group == "" || kind == "" || plural == "" {
		return Info{}, false
	}
	scope, _, _ := unstructured.NestedString(u.Object, "spec", "scope")
	short, _, _ := unstructured.NestedStringSlice(u.Object, "spec", "names", "shortNames")
	versions, _, _ := unstructured.NestedSlice(u.Object, "spec", "versions")

	return Info{
		Group:      group,
		Kind:       kind,
		Plural:     plural,
		ShortNames: short,
		Scope:      scope,
		Version:    storageVersion(versions),
		Operator:   Operator(u.GetLabels()),
	}, true
}

// storageVersion returns the storage version name, else the first served, else
// the first listed, else "".
func storageVersion(versions []interface{}) string {
	var firstServed, firstAny string
	for _, v := range versions {
		m, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		if firstAny == "" {
			firstAny = name
		}
		if storage, _ := m["storage"].(bool); storage {
			return name
		}
		if served, _ := m["served"].(bool); served && firstServed == "" {
			firstServed = name
		}
	}
	if firstServed != "" {
		return firstServed
	}
	return firstAny
}

// CountDisplay maps a single metadata-list page to a display count. A non-empty
// continue token means there are more than Cap items, so report Cap as a floor
// and flag capped.
func CountDisplay(items int, continueToken string) (count int, capped bool) {
	if continueToken != "" {
		return Cap, true
	}
	return items, false
}
```

- [ ] **Step 4: Implement `internal/crd/attribution.go`**

```go
package crd

import "strings"

// operatorLabelKeys are checked in priority order; the first non-empty wins.
var operatorLabelKeys = []string{
	"app.kubernetes.io/name",
	"app.kubernetes.io/part-of",
	"helm.sh/chart",
	"app.kubernetes.io/managed-by",
}

// Operator returns a best-effort owning-operator name from CRD labels, or "".
// For helm.sh/chart the trailing "-<version>" is stripped (e.g.
// "cert-manager-v1.14.2" -> "cert-manager").
func Operator(labels map[string]string) string {
	for _, k := range operatorLabelKeys {
		v := labels[k]
		if v == "" {
			continue
		}
		if k == "helm.sh/chart" {
			return stripChartVersion(v)
		}
		return v
	}
	return ""
}

// stripChartVersion removes a trailing "-<version>" segment (a segment whose
// first character is a digit, optionally after a leading "v").
func stripChartVersion(chart string) string {
	i := strings.LastIndex(chart, "-")
	if i < 0 || i == len(chart)-1 {
		return chart
	}
	rest := chart[i+1:]
	rest = strings.TrimPrefix(rest, "v")
	if rest != "" && rest[0] >= '0' && rest[0] <= '9' {
		return chart[:i]
	}
	return chart
}

// categories maps a CRD API group to a curated category badge. Extend by adding
// a line. Unknown groups return "".
var categories = map[string]string{
	"cilium.io":                       "CNI",
	"kustomize.toolkit.fluxcd.io":     "GITOPS",
	"source.toolkit.fluxcd.io":        "GITOPS",
	"helm.toolkit.fluxcd.io":          "GITOPS",
	"notification.toolkit.fluxcd.io":  "GITOPS",
	"argoproj.io":                     "GITOPS",
	"cert-manager.io":                 "PKI",
	"acme.cert-manager.io":            "PKI",
	"gateway.networking.k8s.io":       "NETWORK",
	"gateway.envoyproxy.io":           "NETWORK",
	"external-secrets.io":             "SECRETS",
	"monitoring.coreos.com":           "OBSERV",
	"postgresql.cnpg.io":              "DATABASE",
}

// Category returns the curated category for a group, or "".
func Category(group string) string { return categories[group] }
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/crd/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/crd/
git commit -m "feat(crd): pure CRD parse + operator/category attribution + count display"
```

---

## Task 2: `ClusterConn.ListCRDs` + `CountResource`

**Files:**
- Create: `internal/fleet/crd.go`, `internal/fleet/crd_test.go`
- Modify: `internal/fleet/conn.go` (`Conn` interface), `internal/fleet/registry_test.go` (`fakeConn`)

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/crd_test.go`:

```go
package fleet

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/crd"
)

func crdUnstructured(group, kind, plural, scope string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   map[string]interface{}{"name": plural + "." + group},
		"spec": map[string]interface{}{
			"group": group,
			"names": map[string]interface{}{"kind": kind, "plural": plural},
			"scope": scope,
			"versions": []interface{}{map[string]interface{}{"name": "v1", "served": true, "storage": true}},
		},
	}}
}

func TestListCRDs(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{crd.GVR: "CustomResourceDefinitionList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds,
		crdUnstructured("cilium.io", "CiliumEndpoint", "ciliumendpoints", "Namespaced"),
		crdUnstructured("cert-manager.io", "Certificate", "certificates", "Namespaced"),
	)
	c := NewClusterConn("x", nil, nil, dyn, nil, clock.Real{})

	infos, err := c.ListCRDs(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(infos) != 2 {
		t.Fatalf("want 2 CRDs, got %d", len(infos))
	}
	byKind := map[string]crd.Info{}
	for _, i := range infos {
		byKind[i.Kind] = i
	}
	if byKind["CiliumEndpoint"].Plural != "ciliumendpoints" || byKind["CiliumEndpoint"].Version != "v1" {
		t.Fatalf("cilium: %+v", byKind["CiliumEndpoint"])
	}
}

func TestCountResourceUncapped(t *testing.T) {
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	mc := metadatafake.NewSimpleMetadataClient(scheme,
		partialMeta("example.com", "v1", "Widget", "a", "w1"),
		partialMeta("example.com", "v1", "Widget", "b", "w2"),
		partialMeta("example.com", "v1", "Widget", "b", "w3"),
	)
	c := NewClusterConn("x", nil, mc, nil, nil, clock.Real{})

	n, capped, err := c.CountResource(context.Background(), "example.com", "v1", "widgets")
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 || capped {
		t.Fatalf("want 3 uncapped, got %d capped=%v", n, capped)
	}
}

func partialMeta(group, version, kind, ns, name string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: group + "/" + version, Kind: kind},
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
	}
}
```

NOTE: this test references a `dynamicScheme()` helper. The fleet package's `gitopsactions_test.go`/`gitopswatch_test.go` already build a `runtime.NewScheme()` for the dynamic fake; reuse the existing helper if one is exported in the test package (e.g. `dynScheme()`), otherwise add `func dynamicScheme() *runtime.Scheme { return runtime.NewScheme() }` here and import `k8s.io/apimachinery/pkg/runtime`. Use whichever name is free; do not duplicate an existing one.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run 'TestListCRDs|TestCountResource' -v`
Expected: FAIL - `c.ListCRDs` / `c.CountResource` undefined.

- [ ] **Step 3: Implement `internal/fleet/crd.go`**

```go
package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/crd"
)

// ListCRDs lists the cluster's CustomResourceDefinitions and parses them. A
// single cheap dynamic list; no watch.
func (c *ClusterConn) ListCRDs(ctx context.Context) ([]crd.Info, error) {
	list, err := c.dyn.Resource(crd.GVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]crd.Info, 0, len(list.Items))
	for i := range list.Items {
		u := &unstructured.Unstructured{Object: list.Items[i].Object}
		if info, ok := crd.ParseCRD(u); ok {
			out = append(out, info)
		}
	}
	return out, nil
}

// CountResource returns a hybrid instance count for a kind via a single
// metadata-only list page (Limit=crd.Cap). count is exact below the cap; at the
// cap with a continue token it is the cap and capped=true.
func (c *ClusterConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: crd.Cap})
	if err != nil {
		return 0, false, err
	}
	count, capped := crd.CountDisplay(len(list.Items), list.GetContinue())
	return count, capped, nil
}
```

- [ ] **Step 4: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add to the `Conn` interface (after `SourceURL`):

```go
	ListCRDs(ctx context.Context) ([]crd.Info, error)
	CountResource(ctx context.Context, group, version, plural string) (int, bool, error)
```

Add the import `"github.com/moomora/klyx/internal/crd"` to `conn.go` if not present.

- [ ] **Step 5: Add `fakeConn` stubs**

In `internal/fleet/registry_test.go`, after the `SourceURL` stub, add (and import `"context"` and `"github.com/moomora/klyx/internal/crd"` if not already imported there):

```go
func (f *fakeConn) ListCRDs(ctx context.Context) ([]crd.Info, error) { return nil, nil }
func (f *fakeConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	return 0, false, nil
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestListCRDs|TestCountResource|Registry' -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`.
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/crd.go internal/fleet/crd_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.ListCRDs + CountResource (lazy, capped)"
```

---

## Task 3: appbridge `CRDService`

**Files:**
- Create: `internal/appbridge/crd_dto.go`, `internal/appbridge/crd_service.go`, `internal/appbridge/crd_service_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/appbridge/crd_service_test.go`:

```go
package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/crd"
)

type fakeCRDConn struct {
	infos  []crd.Info
	counts map[string]int
}

func (f *fakeCRDConn) ListCRDs(ctx context.Context) ([]crd.Info, error) { return f.infos, nil }
func (f *fakeCRDConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	n, ok := f.counts[plural]
	if !ok {
		return 0, false, nil
	}
	return n, n >= crd.Cap, nil
}

func TestListCRDsGroupsAndAttributes(t *testing.T) {
	conn := &fakeCRDConn{infos: []crd.Info{
		{Group: "cilium.io", Kind: "CiliumNode", Plural: "ciliumnodes", Scope: "Cluster", Version: "v2", Operator: "cilium"},
		{Group: "cilium.io", Kind: "CiliumEndpoint", Plural: "ciliumendpoints", Scope: "Namespaced", Version: "v2", Operator: "cilium"},
		{Group: "cert-manager.io", Kind: "Certificate", Plural: "certificates", Scope: "Namespaced", Version: "v1", Operator: "cert-manager"},
	}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	groups := svc.ListCRDs("x")
	if len(groups) != 2 {
		t.Fatalf("want 2 groups, got %d", len(groups))
	}
	// Sorted by group name: cert-manager.io before cilium.io.
	if groups[0].Group != "cert-manager.io" || groups[1].Group != "cilium.io" {
		t.Fatalf("group order: %s, %s", groups[0].Group, groups[1].Group)
	}
	if groups[1].Category != "CNI" {
		t.Fatalf("cilium category: %q", groups[1].Category)
	}
	// Kinds within cilium sorted by kind: CiliumEndpoint before CiliumNode.
	if groups[1].Kinds[0].Kind != "CiliumEndpoint" || groups[1].Kinds[1].Kind != "CiliumNode" {
		t.Fatalf("kind order: %+v", groups[1].Kinds)
	}
}

func TestListCRDsUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if g := svc.ListCRDs("ghost"); len(g) != 0 {
		t.Fatalf("want empty, got %d", len(g))
	}
}

func TestCountKind(t *testing.T) {
	conn := &fakeCRDConn{counts: map[string]int{"ciliumendpoints": crd.Cap, "certificates": 4}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	if c := svc.CountKind("x", "cilium.io", "v2", "ciliumendpoints"); c.Count != crd.Cap || !c.Capped {
		t.Fatalf("capped: %+v", c)
	}
	if c := svc.CountKind("x", "cert-manager.io", "v1", "certificates"); c.Count != 4 || c.Capped {
		t.Fatalf("exact: %+v", c)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestListCRDs|TestCountKind' -v`
Expected: FAIL - `NewCRDService` / DTOs undefined.

- [ ] **Step 3: Implement `internal/appbridge/crd_dto.go`**

```go
package appbridge

import (
	"sort"

	"github.com/moomora/klyx/internal/crd"
)

// CRDKindDTO is one custom-resource kind within a group.
type CRDKindDTO struct {
	Kind       string   `json:"kind"`
	Plural     string   `json:"plural"`
	Scope      string   `json:"scope"`
	Version    string   `json:"version"`
	Operator   string   `json:"operator"`
	ShortNames []string `json:"shortNames"`
}

// CRDGroupDTO is an API group with its curated category and kinds.
type CRDGroupDTO struct {
	Group    string       `json:"group"`
	Category string       `json:"category"`
	Kinds    []CRDKindDTO `json:"kinds"`
}

// CRDCountDTO is a hybrid instance count for one kind.
type CRDCountDTO struct {
	Count  int  `json:"count"`
	Capped bool `json:"capped"`
}

// groupCRDs groups parsed CRDs by API group, attaches the curated category, and
// sorts groups and kinds by name for a stable UI.
func groupCRDs(infos []crd.Info) []CRDGroupDTO {
	byGroup := map[string][]CRDKindDTO{}
	for _, i := range infos {
		byGroup[i.Group] = append(byGroup[i.Group], CRDKindDTO{
			Kind: i.Kind, Plural: i.Plural, Scope: i.Scope,
			Version: i.Version, Operator: i.Operator, ShortNames: i.ShortNames,
		})
	}
	out := make([]CRDGroupDTO, 0, len(byGroup))
	for group, kinds := range byGroup {
		sort.Slice(kinds, func(a, b int) bool { return kinds[a].Kind < kinds[b].Kind })
		out = append(out, CRDGroupDTO{Group: group, Category: crd.Category(group), Kinds: kinds})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Group < out[b].Group })
	return out
}
```

- [ ] **Step 4: Implement `internal/appbridge/crd_service.go`**

```go
package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/crd"
)

// CRDConn is the per-cluster read surface CRDService needs.
type CRDConn interface {
	ListCRDs(ctx context.Context) ([]crd.Info, error)
	CountResource(ctx context.Context, group, version, plural string) (int, bool, error)
}

const crdTimeout = 30 * time.Second

// CRDService is bound to JS. Pure request/response: ListCRDs returns the grouped
// tree (no counts); CountKind lazily counts one kind on group-expand.
type CRDService struct {
	lookup func(string) (CRDConn, bool)
}

func NewCRDService(lookup func(string) (CRDConn, bool)) *CRDService {
	return &CRDService{lookup: lookup}
}

// ListCRDs returns the cluster's CRDs grouped by API group with category and
// sorted deterministically. Empty on a cluster miss or a list error.
func (s *CRDService) ListCRDs(cluster string) []CRDGroupDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return []CRDGroupDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	infos, err := conn.ListCRDs(ctx)
	if err != nil {
		return []CRDGroupDTO{}
	}
	return groupCRDs(infos)
}

// CountKind returns the hybrid instance count for one kind. Zero value on miss.
func (s *CRDService) CountKind(cluster, group, version, plural string) CRDCountDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return CRDCountDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	count, capped, err := conn.CountResource(ctx, group, version, plural)
	if err != nil {
		return CRDCountDTO{}
	}
	return CRDCountDTO{Count: count, Capped: capped}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -run 'TestListCRDs|TestCountKind' -v` then `go test ./internal/appbridge/` and `go vet ./internal/appbridge/`.
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/crd_dto.go internal/appbridge/crd_service.go internal/appbridge/crd_service_test.go
git commit -m "feat(appbridge): CRDService - grouped CRD DTOs + lazy CountKind"
```

---

## Task 4: Register `CRDService` in main.go

**Files:**
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Construct and register the service**

In `cmd/klyx/main.go`, after the `gitopsSvc := appbridge.NewGitOpsService(...)` block (around line 61), add:

```go
	crdSvc := appbridge.NewCRDService(func(name string) (appbridge.CRDConn, bool) {
		c, ok := reg.Conn(name)
		if !ok {
			return nil, false
		}
		return c, true
	})
```

In the `application.New(application.Options{ ... Services: []application.Service{ ... } })` slice (around line 66-69), add a line after `application.NewService(gitopsSvc),`:

```go
				application.NewService(crdSvc),
```

- [ ] **Step 2: Build to verify it compiles**

Run: `make build 2>&1 | grep -vE "ld: warning|object file" | tail` (the fleet `Conn` must satisfy `appbridge.CRDConn` via the methods from Task 2).
Expected: builds clean (ignore linker warnings and the known `cmd/klyx/build/ios` scaffold).

- [ ] **Step 3: Commit**

```bash
git add cmd/klyx/main.go
git commit -m "feat: register CRDService with the Wails app"
```

---

## Task 5: Frontend store `crd` slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Create: `cmd/klyx/frontend/src/bridge/crd.ts`

- [ ] **Step 1: Write the failing store test**

Add to `cmd/klyx/frontend/src/store/fleet.test.ts`:

```ts
import { useFleet, crdCountKey } from "./fleet";

test("crd slice: set groups, toggle, count, search, groupBy", () => {
  useFleet.getState().setCRDs("x", [
    { group: "cilium.io", category: "CNI", kinds: [{ kind: "CiliumEndpoint", plural: "ciliumendpoints", scope: "Namespaced", version: "v2", operator: "cilium", shortNames: ["cep"] }] },
  ]);
  expect(useFleet.getState().crd.groups.length).toBe(1);

  useFleet.getState().toggleCRDGroup("cilium.io");
  expect(useFleet.getState().crd.expanded).toContain("cilium.io");
  useFleet.getState().toggleCRDGroup("cilium.io");
  expect(useFleet.getState().crd.expanded).not.toContain("cilium.io");

  const key = crdCountKey("cilium.io", "v2", "ciliumendpoints");
  useFleet.getState().setCRDCount(key, { count: 500, capped: true });
  expect(useFleet.getState().crd.counts[key].capped).toBe(true);

  useFleet.getState().setCRDGroupBy("scope");
  expect(useFleet.getState().crd.groupBy).toBe("scope");
  useFleet.getState().setCRDSearch("cep");
  expect(useFleet.getState().crd.search).toBe("cep");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "crd slice"`
Expected: FAIL - setters undefined.

- [ ] **Step 3: Implement the store additions**

In `src/store/fleet.ts`, add types (near the other DTO types):

```ts
export type CRDKindDTO = { kind: string; plural: string; scope: string; version: string; operator: string; shortNames: string[] };
export type CRDGroupDTO = { group: string; category: string; kinds: CRDKindDTO[] };
export type CRDCountDTO = { count: number; capped: boolean };
export type CRDGroupBy = "group" | "operator" | "scope" | "alphabetical";

export type CRDSlice = {
  cluster: string | null;
  groups: CRDGroupDTO[];
  loading: boolean;
  expanded: string[];
  counts: Record<string, CRDCountDTO>;
  groupBy: CRDGroupBy;
  search: string;
};

export const crdCountKey = (group: string, version: string, plural: string) => `${group}/${version}/${plural}`;
```

Add to the `FleetState` type:

```ts
  crd: CRDSlice;
  setCRDs: (cluster: string, groups: CRDGroupDTO[]) => void;
  setCRDLoading: (cluster: string) => void;
  clearCRDs: () => void;
  toggleCRDGroup: (group: string) => void;
  setCRDCount: (key: string, dto: CRDCountDTO) => void;
  setCRDGroupBy: (g: CRDGroupBy) => void;
  setCRDSearch: (s: string) => void;
```

Add to the store body (inside `create<FleetState>((set) => ({ ... }))`):

```ts
  crd: { cluster: null, groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "" },
  setCRDs: (cluster, groups) => set((s) => ({ crd: { ...s.crd, cluster, groups, loading: false } })),
  setCRDLoading: (cluster) => set((s) => ({ crd: { ...s.crd, cluster, groups: [], loading: true, expanded: [], counts: {} } })),
  clearCRDs: () => set({ crd: { cluster: null, groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "" } }),
  toggleCRDGroup: (group) => set((s) => ({
    crd: { ...s.crd, expanded: s.crd.expanded.includes(group) ? s.crd.expanded.filter((g) => g !== group) : [...s.crd.expanded, group] },
  })),
  setCRDCount: (key, dto) => set((s) => ({ crd: { ...s.crd, counts: { ...s.crd.counts, [key]: dto } } })),
  setCRDGroupBy: (groupBy) => set((s) => ({ crd: { ...s.crd, groupBy } })),
  setCRDSearch: (search) => set((s) => ({ crd: { ...s.crd, search } })),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "crd slice"`
Expected: PASS.

- [ ] **Step 5: Create the bridge**

Create `cmd/klyx/frontend/src/bridge/crd.ts`:

```ts
import { useFleet, CRDGroupDTO, CRDCountDTO, crdCountKey } from "../store/fleet";
import { CRDService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listCRDs(cluster: string): Promise<void> {
  useFleet.getState().setCRDLoading(cluster);
  const groups = (await CRDService.ListCRDs(cluster)) as CRDGroupDTO[];
  useFleet.getState().setCRDs(cluster, groups ?? []);
}

export async function countKind(cluster: string, group: string, version: string, plural: string): Promise<void> {
  const c = (await CRDService.CountKind(cluster, group, version, plural)) as CRDCountDTO;
  useFleet.getState().setCRDCount(crdCountKey(group, version, plural), c);
}
```

NOTE: `CRDService` exists in the generated bindings only after Task 7 regenerates them. `tsc` here will not resolve it yet - that is expected and matches the M3-c approach (vitest mocks the bridge in component tests; the full typecheck happens in Task 7). Do NOT run `npm run build` in this task.

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts cmd/klyx/frontend/src/bridge/crd.ts
git commit -m "feat(ui): crd store slice + listCRDs/countKind bridge"
```

---

## Task 6: `CRDBrowser` view

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/CRDBrowser.tsx`, `cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`

- [ ] **Step 1: Write the failing tests**

Create `cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, CRDGroupDTO, crdCountKey } from "../store/fleet";
import { CRDBrowser } from "./CRDBrowser";

vi.mock("../bridge/crd", () => ({
  listCRDs: vi.fn(async () => {}),
  countKind: vi.fn(async () => {}),
}));
import { countKind } from "../bridge/crd";

const groups: CRDGroupDTO[] = [
  { group: "cilium.io", category: "CNI", kinds: [
    { kind: "CiliumEndpoint", plural: "ciliumendpoints", scope: "Namespaced", version: "v2", operator: "cilium", shortNames: ["cep"] },
    { kind: "CiliumNode", plural: "ciliumnodes", scope: "Cluster", version: "v2", operator: "cilium", shortNames: [] },
  ] },
  { group: "cert-manager.io", category: "PKI", kinds: [
    { kind: "Certificate", plural: "certificates", scope: "Namespaced", version: "v1", operator: "cert-manager", shortNames: ["cert"] },
  ] },
];

beforeEach(() => useFleet.setState({
  crd: { cluster: "x", groups, loading: false, expanded: [], counts: {}, groupBy: "group", search: "" },
}));

describe("CRDBrowser", () => {
  it("renders groups with category badges", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("cilium.io")).toBeTruthy();
    expect(getByText("CNI")).toBeTruthy();
    expect(getByText("cert-manager.io")).toBeTruthy();
  });

  it("expands a group, shows kinds, and fires countKind", () => {
    const { getByText } = render(<CRDBrowser cluster="x" />);
    fireEvent.click(getByText("cilium.io"));
    expect(getByText("CiliumEndpoint")).toBeTruthy();
    expect(countKind).toHaveBeenCalledWith("x", "cilium.io", "v2", "ciliumendpoints");
  });

  it("renders 500+ when a count is capped", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, expanded: ["cilium.io"], counts: { [crdCountKey("cilium.io", "v2", "ciliumendpoints")]: { count: 500, capped: true } } } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("500+")).toBeTruthy();
  });

  it("filters by search", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, search: "certificate" } });
    const { queryByText } = render(<CRDBrowser cluster="x" />);
    expect(queryByText("cilium.io")).toBeNull();
    expect(queryByText("cert-manager.io")).toBeTruthy();
  });

  it("regroups by scope", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, groupBy: "scope" } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText("Cluster")).toBeTruthy();
    expect(getByText("Namespaced")).toBeTruthy();
  });

  it("shows the empty state when there are no CRDs", () => {
    useFleet.setState({ crd: { ...useFleet.getState().crd, groups: [] } });
    const { getByText } = render(<CRDBrowser cluster="x" />);
    expect(getByText(/No custom resources/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/CRDBrowser.test.tsx`
Expected: FAIL - cannot find module `./CRDBrowser`.

- [ ] **Step 3: Implement `CRDBrowser.tsx`**

```tsx
import { useEffect } from "react";
import { useFleet, CRDGroupDTO, CRDKindDTO, CRDGroupBy, crdCountKey } from "../store/fleet";
import { listCRDs, countKind } from "../bridge/crd";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

type FlatKind = CRDKindDTO & { group: string; category: string };

function flatten(groups: CRDGroupDTO[]): FlatKind[] {
  return groups.flatMap((g) => g.kinds.map((k) => ({ ...k, group: g.group, category: g.category })));
}

// reshape turns the api-group groups into display sections per the groupBy mode.
function reshape(groups: CRDGroupDTO[], groupBy: CRDGroupBy): { label: string; category: string; kinds: FlatKind[] }[] {
  if (groupBy === "group") {
    return groups.map((g) => ({ label: g.group, category: g.category, kinds: g.kinds.map((k) => ({ ...k, group: g.group, category: g.category })) }));
  }
  const flat = flatten(groups);
  if (groupBy === "alphabetical") {
    return [{ label: "all kinds", category: "", kinds: [...flat].sort((a, b) => a.kind.localeCompare(b.kind)) }];
  }
  const keyOf = (k: FlatKind) => (groupBy === "scope" ? (k.scope || "unknown") : (k.operator || "unattributed"));
  const buckets = new Map<string, FlatKind[]>();
  for (const k of flat) {
    const key = keyOf(k);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(k);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, kinds]) => ({ label, category: "", kinds: kinds.sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

function matches(k: FlatKind, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return k.kind.toLowerCase().includes(s) || k.group.toLowerCase().includes(s) || (k.operator ?? "").toLowerCase().includes(s);
}

const GROUP_BYS: CRDGroupBy[] = ["group", "operator", "scope", "alphabetical"];
const GROUP_BY_LABEL: Record<CRDGroupBy, string> = { group: "api group", operator: "operator", scope: "scope", alphabetical: "alphabetical" };

export function CRDBrowser({ cluster }: { cluster: string }) {
  const crd = useFleet((s) => s.crd);
  const setGroupBy = useFleet((s) => s.setCRDGroupBy);
  const setSearch = useFleet((s) => s.setCRDSearch);

  useEffect(() => {
    listCRDs(cluster).catch((e) => console.error("listCRDs", e));
    return () => useFleet.getState().clearCRDs();
  }, [cluster]);

  const groups = crd.cluster === cluster ? crd.groups : [];
  const sections = reshape(groups, crd.groupBy).map((sec) => ({ ...sec, kinds: sec.kinds.filter((k) => matches(k, crd.search)) })).filter((sec) => sec.kinds.length > 0);

  const totalKinds = flatten(groups).length;
  const countedInstances = Object.values(crd.counts).reduce((n, c) => n + c.count, 0);

  if (crd.loading && groups.length === 0) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading custom resources…</div>;
  }
  if (groups.length === 0) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>No custom resources found on this cluster.</div>;
  }

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          <b style={{ color: "var(--color-text-primary)" }}>{groups.length}</b> groups · <b style={{ color: "var(--color-text-primary)" }}>{totalKinds}</b> kinds · <b style={{ color: "var(--color-text-primary)" }}>{Object.keys(crd.counts).length ? countedInstances : "…"}</b> instances
        </div>
        <div style={{ flex: 1 }} />
        <input
          value={crd.search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="kind, group, operator…"
          style={{ width: 200, height: 28, paddingLeft: 10, fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
        />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, fontSize: 11, alignItems: "center" }}>
        <span style={{ color: "var(--color-text-tertiary)" }}>group by:</span>
        {GROUP_BYS.map((g) => (
          <button
            key={g}
            onClick={() => setGroupBy(g)}
            style={{
              padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 11,
              border: "0.5px solid var(--color-border-tertiary)",
              background: crd.groupBy === g ? "var(--color-background-info)" : "transparent",
              color: crd.groupBy === g ? "var(--color-text-info)" : "var(--color-text-secondary)",
            }}
          >
            {GROUP_BY_LABEL[g]}
          </button>
        ))}
      </div>

      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
        {sections.map((sec) => (
          <Section key={sec.label} cluster={cluster} label={sec.label} category={sec.category} kinds={sec.kinds} grouped={crd.groupBy === "group"} />
        ))}
      </div>
    </div>
  );
}

function Section({ cluster, label, category, kinds, grouped }: { cluster: string; label: string; category: string; kinds: FlatKind[]; grouped: boolean }) {
  const expanded = useFleet((s) => s.crd.expanded);
  const counts = useFleet((s) => s.crd.counts);
  const toggle = useFleet((s) => s.toggleCRDGroup);
  // In non-grouped modes there is no lazy-count gating; always show kinds and count on mount.
  const open = !grouped || expanded.includes(label);

  useEffect(() => {
    if (!open) return;
    for (const k of kinds) {
      if (!counts[crdCountKey(k.group, k.version, k.plural)]) {
        void countKind(cluster, k.group, k.version, k.plural);
      }
    }
  }, [open, cluster, kinds, counts]);

  const sectionInstances = kinds.reduce((n, k) => n + (counts[crdCountKey(k.group, k.version, k.plural)]?.count ?? 0), 0);

  return (
    <div>
      <div
        onClick={() => grouped && toggle(label)}
        style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px 1fr", gap: 10, alignItems: "center", padding: "8px 12px", background: "var(--color-background-secondary)", cursor: grouped ? "pointer" : "default", borderTop: "0.5px solid var(--color-border-tertiary)" }}
      >
        <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>{grouped ? (open ? "▾" : "▸") : ""}</span>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, ...ellipsis }}>{label}</div>
        {category ? <span style={{ background: "var(--color-background-primary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 6px", borderRadius: 3, letterSpacing: 0.3, justifySelf: "start" }}>{category}</span> : <span />}
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{kinds.length} kinds</span>
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{Object.keys(counts).length ? `${sectionInstances} instances` : "…"}</span>
      </div>
      {open && kinds.map((k) => {
        const c = counts[crdCountKey(k.group, k.version, k.plural)];
        const display = c ? (c.capped ? `${c.count}+` : `${c.count}`) : "…";
        return (
          <div key={`${k.group}/${k.kind}`} style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px 1fr", gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11 }}>
            <span />
            <div style={{ fontFamily: "var(--font-mono)", ...ellipsis }}>{k.kind} {k.shortNames[0] && <span style={{ color: "var(--color-text-tertiary)" }}>{k.shortNames[0]}</span>}</div>
            <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 5px", borderRadius: 3, justifySelf: "start" }}>{k.scope.toLowerCase()}</span>
            <span style={{ fontWeight: 500 }}>{display}</span>
            <span style={{ color: "var(--color-text-tertiary)", ...ellipsis }}>{k.operator}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Wire into `ClusterDetail.tsx`**

In `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`, add the import and a branch. Add after the `GitOps` import:

```tsx
import { CRDBrowser } from "./CRDBrowser";
```
Change the section switch (currently lines ~22-24) so `resources` renders the browser:

```tsx
  if (route.section === "overview") return <Overview c={cluster} />;
  if (route.section === "gitops") return <GitOps cluster={cluster.name} />;
  if (route.section === "resources") return <CRDBrowser cluster={cluster.name} />;
  return <Placeholder section={route.section} c={cluster} />;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/CRDBrowser.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/CRDBrowser.tsx cmd/klyx/frontend/src/cluster/CRDBrowser.test.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx
git commit -m "feat(ui): CRDBrowser - grouped kinds, group-by, search, lazy counts"
```

---

## Task 7: Regenerate bindings, full build, verification

**Files:**
- Regenerated: `cmd/klyx/frontend/bindings/**` (gitignored)

- [ ] **Step 1: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, race + vet clean.

- [ ] **Step 2: Regenerate bindings + frontend suite + full native build**

```bash
cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
grep -rn "ListCRDs\|CountKind" frontend/bindings/github.com/moomora/klyx/internal/appbridge/ | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show `ListCRDs`/`CountKind`; vitest all green; `tsc` clean; `wails3 build` exit 0.

- [ ] **Step 3: Native handoff (manual, owner)**

On `homelab-nelli`: open a cluster → Resources tab. Confirm CRD groups render instantly with category badges; expand `cilium.io` and confirm it fills fast with a `500+` on `CiliumEndpoint`/`CiliumIdentity` and exact small counts elsewhere; check group-by toggles (operator/scope/alphabetical) and the search filter.

- [ ] **Step 4: Commit any build-surfaced fixes** (skip if none)

```bash
git add -A && git commit -m "chore(m4-a): verification fixes"
```

---

## Self-review notes

- **Spec coverage:** §2 CRD discovery → Tasks 1 (`ParseCRD`) + 2 (`ListCRDs`). §3 hybrid counts → Tasks 1 (`CountDisplay`, `Cap`) + 2 (`CountResource`). §4 attribution → Task 1 (`Operator`, `Category`). §5 appbridge → Task 3. §6 frontend → Tasks 5-6. Capability/empty state → Task 6. Testing §7 → every task's tests + Task 7 native handoff.
- **No watch:** `ListCRDs`/`CountResource` are one-shot lists; the store clears on cluster change; nothing retained. Confirmed against the Cilium concern.
- **Verified fake patterns:** the metadata fake seeding (`PartialObjectMetadata` + `AddMetaToScheme` + regular-plural GVR) and the dynamic fake CRD-list pattern were both empirically confirmed before writing. The capped-count path is covered by the pure `CountDisplay` test (the metadata fake does not paginate); `CountResource`'s uncapped path is covered against the fake.
- **Binding timing:** `bridge/crd.ts` references `CRDService` before Task 7 regenerates bindings; vitest mocks the bridge in `CRDBrowser.test.tsx`, so unit tests pass regardless; the full `tsc` + build happens in Task 7 (same pattern proven in M3-c).
- **Type consistency:** `CRDKindDTO`/`CRDGroupDTO`/`CRDCountDTO` identical Go (json `kind/plural/scope/version/operator/shortNames`, `group/category/kinds`, `count/capped`) ↔ TS. `crdCountKey(group, version, plural)` used identically in store, bridge, and view. `ListCRDs`/`CountResource` signatures match across `Conn`, `CRDConn`, `ClusterConn`, and both fakes.
- **`Conn` interface ripple:** `ListCRDs`/`CountResource` added to the fleet `Conn` (Task 2: `ClusterConn` + `fakeConn`); `appbridge.CRDConn` is satisfied by the fleet `Conn` (Task 4 build proves it) and stubbed by `fakeCRDConn` (Task 3).
