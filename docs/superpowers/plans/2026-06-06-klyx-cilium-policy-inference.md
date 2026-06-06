# M5-b-ii: Cilium Policy Inference (CNP/CCNP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface CiliumNetworkPolicy (CNP) and CiliumClusterwideNetworkPolicy (CCNP) against the topology's backing workloads by a normalized label heuristic — marked `Inferred`, rendered visibly softer than the precise Envoy chips, attached on the **Pods** box, with broad CCNPs as header-only cluster-wide context.

**Architecture:** Pure `internal/gwapi` gains label normalization, a kind-agnostic selector classifier, a subset test, a Cilium decoder (added to the existing registry), and a `CiliumPolicyRef` builder. `internal/fleet` adds a *separate* `attachCiliumPolicies` pass (reusing the M5-b-i discovery + two-warning-class machinery) that maps the classifier's result by CNP-vs-CCNP into `ServiceNode.CNPs` / `Topology.ClusterPolicies`. The appbridge DTO + React renderer carry it through, with inferred chips given a distinct dashed/muted treatment. Snapshot, no watch.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic + typed + fake discovery), Wails v3, React 19 + TS 6 + Vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-06-klyx-cilium-policy-inference-design.md`. This is the inferred counterpart to M5-b-i (precise); it only ever sets `Inferred=true`.

---

## Context the engineer needs

- **The seam:** precise targetRef policies live on `Gateway/Route/ServiceNode.Policies` (M5-b-i). Inferred Cilium policies live on `ServiceNode.CNPs` and `Topology.ClusterPolicies` (this slice). Never mix.
- **Honesty ladder** (loosest→tightest): cluster-wide (broad CCNP → header) > namespace-wide (empty CNP selector → all services in ns) > selector (matchLabels ⊆ Service selector → the matched workload).
- **Label-subset needs the Service selector.** The current `gwapi.ServiceNode` does NOT store `spec.selector`. This plan adds an internal `Selector map[string]string` field (Go-only, NOT in the DTO) populated in `resolveBackends`, and the Cilium pass matches against it.
- **"Broad" = `SelectorEmpty` after normalization** (absent/empty, or only dropped metadata labels remained). A non-empty normalized matchLabels selector is always tested, never treated as broad.
- **matchExpressions:** attach only when matchLabels also subset-matches (+ a "not fully evaluated" detail); expressions-only → one warning, no chip.
- **Pure classifier is kind-agnostic.** `ClassifyCiliumSelector` returns `SelectorEmpty|SelectorLabels|SelectorExpressionsOnly` — it does NOT decide namespace-wide vs cluster-wide. The fleet layer maps class + kind → `PolicyMatchKind`.
- **The decoder registry** (`internal/gwapi/policy_decode.go`) already has `Decode(kind, u)` + `feat` helper; CNP/CCNP get one shared decoder added to it.
- **Existing GVR discovery** (`servedResourceGVR`, `policyCandidateVersions` in `internal/fleet/gateway.go`) + the two warning classes are reused verbatim; add `cilium.io: {"v2"}`.
- **Chip placement:** CNP/CCNP chips render on the **Pods** box (precise BackendTLSPolicy stays on the Service box). Inferred chips: dashed outline, muted, leading `~`, distinct `CNP`/`CCNP` label, tooltip leading with the honesty note.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gwapi/model.go` | `PolicyMatchKind`, `PolicyRef.Match`, `Topology.ClusterPolicies`, `ServiceNode.Selector` | Modify |
| `internal/gwapi/cilium.go` | `NormalizeCiliumLabels`, `ClassifyCiliumSelector`, `LabelsSubset`, `CiliumPolicyRef` | Create |
| `internal/gwapi/cilium_test.go` | normalize/classify/subset/builder tests | Create |
| `internal/gwapi/policy_decode.go` | `decodeCNP` + registry entries | Modify |
| `internal/gwapi/policy_decode_test.go` | CNP decoder tests | Modify |
| `internal/fleet/gateway.go` | `attachCiliumPolicies`, `ServiceNode.Selector` populate, `cilium.io` version, call site | Modify |
| `internal/fleet/gateway_cilium_test.go` | CNP/CCNP attach + warning tests | Create |
| `internal/appbridge/gateway_dto.go` | `PolicyRefDTO.Match`, `TopologyDTO.ClusterPolicies`, mapper | Modify |
| `internal/appbridge/gateway_service_test.go` | DTO mapping test | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | TS `PolicyRefDTO.match`, `TopologyDTO.clusterPolicies` | Modify |
| `cmd/klyx/frontend/src/cluster/PolicyChip.tsx` | inferred dashed/muted styling, CNP/CCNP colours, tooltip honesty note | Modify |
| `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx` | inferred chip + tooltip tests | Modify |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx` | pods-box chips, header cluster-wide group, detail inferred sub-group | Modify |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` | inferred render tests | Modify |

---

## Task 1: `gwapi` model + Cilium selector logic

**Files:**
- Modify: `internal/gwapi/model.go`
- Create: `internal/gwapi/cilium.go`, `internal/gwapi/cilium_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gwapi/cilium_test.go`:

```go
package gwapi

import (
	"reflect"
	"testing"
)

func TestNormalizeCiliumLabels(t *testing.T) {
	in := map[string]string{
		"k8s:app":                          "grafana",
		"app":                              "extra",
		"k8s:io.kubernetes.pod.namespace":  "monitoring",
		"io.cilium.k8s.policy.cluster":     "default",
		"reserved:host":                    "",
	}
	got := NormalizeCiliumLabels(in)
	want := map[string]string{"app": "extra"} // "k8s:app" strips to "app" then collides; meta keys dropped
	// Note: both "k8s:app" and "app" normalize to key "app"; last write wins is acceptable -
	// assert the meta keys are gone and "app" survives with a non-empty value.
	if _, ok := got["io.kubernetes.pod.namespace"]; ok {
		t.Fatalf("meta key survived: %+v", got)
	}
	if _, ok := got["io.cilium.k8s.policy.cluster"]; ok {
		t.Fatalf("cilium meta survived: %+v", got)
	}
	if v, ok := got["app"]; !ok || v == "" {
		t.Fatalf("app label lost: %+v", got)
	}
	_ = want
}

func TestNormalizeNeverInvents(t *testing.T) {
	in := map[string]string{"tier": "frontend", "team": "obs"}
	got := NormalizeCiliumLabels(in)
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("non-meta labels must pass through unchanged: %+v", got)
	}
}

func sel(matchLabels map[string]interface{}, matchExpressions []interface{}) map[string]interface{} {
	m := map[string]interface{}{}
	if matchLabels != nil {
		m["matchLabels"] = matchLabels
	}
	if matchExpressions != nil {
		m["matchExpressions"] = matchExpressions
	}
	return m
}

func TestClassifyCiliumSelector(t *testing.T) {
	// empty
	if cl, _, _ := ClassifyCiliumSelector(nil); cl != SelectorEmpty {
		t.Fatalf("nil → empty, got %v", cl)
	}
	if cl, _, _ := ClassifyCiliumSelector(map[string]interface{}{}); cl != SelectorEmpty {
		t.Fatalf("{} → empty, got %v", cl)
	}
	// only meta labels → empty after normalization (broad)
	if cl, _, _ := ClassifyCiliumSelector(sel(map[string]interface{}{"io.kubernetes.pod.namespace": "x"}, nil)); cl != SelectorEmpty {
		t.Fatalf("meta-only → empty, got %v", cl)
	}
	// labels
	cl, labels, hasExpr := ClassifyCiliumSelector(sel(map[string]interface{}{"k8s:app": "grafana"}, nil))
	if cl != SelectorLabels || labels["app"] != "grafana" || hasExpr {
		t.Fatalf("labels: %v %+v %v", cl, labels, hasExpr)
	}
	// labels + expressions
	cl, _, hasExpr = ClassifyCiliumSelector(sel(map[string]interface{}{"app": "g"}, []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists"}}))
	if cl != SelectorLabels || !hasExpr {
		t.Fatalf("labels+expr: %v %v", cl, hasExpr)
	}
	// expressions only
	if cl, _, _ := ClassifyCiliumSelector(sel(nil, []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists"}})); cl != SelectorExpressionsOnly {
		t.Fatalf("expr-only, got %v", cl)
	}
}

func TestLabelsSubset(t *testing.T) {
	svc := map[string]string{"app": "grafana", "tier": "frontend"}
	if !LabelsSubset(map[string]string{"app": "grafana"}, svc) {
		t.Fatal("subset should match")
	}
	if LabelsSubset(map[string]string{"app": "other"}, svc) {
		t.Fatal("value mismatch should not match")
	}
	if LabelsSubset(map[string]string{}, svc) {
		t.Fatal("empty labels never match (use namespace-wide path instead)")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run 'TestNormalize|TestClassify|TestLabelsSubset' -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Add model types to `internal/gwapi/model.go`**

Add the `Match` field to `PolicyRef` (after `Inferred`):

```go
	Inferred bool           // false for all M5-b-i Envoy policies; reserved for Cilium (M5-b-ii)
	Match    PolicyMatchKind // empty for precise policies; set for inferred Cilium policies
```

Add the enum + a `ClusterPolicies` field on `Topology` + a `Selector` field on `ServiceNode`. Place the enum near `PolicyRef`:

```go
// PolicyMatchKind describes HOW an inferred policy matched. An expressions-only policy
// never produces a PolicyRef (warned + skipped), so there is no "matchExpressions" value.
type PolicyMatchKind string

const (
	MatchSelector      PolicyMatchKind = "selector"
	MatchNamespaceWide PolicyMatchKind = "namespace-wide"
	MatchClusterWide   PolicyMatchKind = "cluster-wide"
)
```

In `Topology`, add `ClusterPolicies`:

```go
type Topology struct {
	Gateway         GatewayNode
	Routes          []RouteNode // one lane each
	ClusterPolicies []PolicyRef // broad/empty CCNPs - header context, not per-service (M5-b-ii)
	Warnings        []string    // soft, non-fatal issues (filled by the fleet layer)
}
```

In `ServiceNode`, add `Selector` (Go-only, not exposed in the DTO):

```go
type ServiceNode struct {
	Namespace, Name, Type string
	Port                  int32
	Selector              map[string]string // svc spec.selector; internal, for CNP label matching
	Policies              []PolicyRef       // M5-b-i: precise (BackendTLSPolicy)
	CNPs                  []PolicyRef       // M5-b-ii: inferred Cilium
	Resolved              bool              // false when the Service could not be read
}
```

- [ ] **Step 4: Implement `internal/gwapi/cilium.go`**

```go
package gwapi

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// SelectorClass classifies a Cilium endpointSelector AFTER normalization. It is
// kind-agnostic: mapping empty → namespace-wide (CNP) vs cluster-wide (CCNP) is the
// fleet layer's job, since only it knows the policy kind.
type SelectorClass int

const (
	SelectorEmpty           SelectorClass = iota // no usable matchLabels and no matchExpressions
	SelectorLabels                               // usable normalized matchLabels present
	SelectorExpressionsOnly                      // matchExpressions but no usable matchLabels
)

// NormalizeCiliumLabels strips the "k8s:" source prefix and drops known metadata keys
// (io.kubernetes.*, io.cilium.*, reserved:*). Invariant: it NEVER invents a label - it
// only strips known prefixes and drops known metadata; any other key passes through.
func NormalizeCiliumLabels(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		k = strings.TrimPrefix(k, "k8s:")
		switch {
		case strings.HasPrefix(k, "io.kubernetes."),
			strings.HasPrefix(k, "io.cilium."),
			strings.HasPrefix(k, "reserved:"):
			continue
		}
		out[k] = v
	}
	return out
}

// ClassifyCiliumSelector reads an endpointSelector and classifies it post-normalization.
// Returns the class, the normalized matchLabels, and whether matchExpressions is present.
func ClassifyCiliumSelector(endpointSelector map[string]interface{}) (SelectorClass, map[string]string, bool) {
	if endpointSelector == nil {
		return SelectorEmpty, map[string]string{}, false
	}
	raw, _, err := unstructured.NestedStringMap(endpointSelector, "matchLabels")
	if err != nil {
		raw = nil
	}
	labels := NormalizeCiliumLabels(raw)
	exprs, _, _ := unstructured.NestedSlice(endpointSelector, "matchExpressions")
	hasExpr := len(exprs) > 0
	if len(labels) > 0 {
		return SelectorLabels, labels, hasExpr
	}
	if hasExpr {
		return SelectorExpressionsOnly, labels, true
	}
	return SelectorEmpty, labels, false
}

// LabelsSubset reports whether every key/value in labels is present in serviceSelector.
// Empty labels never match (the namespace-wide path handles that case instead).
func LabelsSubset(labels, serviceSelector map[string]string) bool {
	if len(labels) == 0 {
		return false
	}
	for k, v := range labels {
		if serviceSelector[k] != v {
			return false
		}
	}
	return true
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/gwapi/ -run 'TestNormalize|TestClassify|TestLabelsSubset' -v` then `go build ./...` and `go vet ./internal/gwapi/`
Expected: PASS; build clean (the additive model change doesn't break appbridge/fleet); vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/gwapi/model.go internal/gwapi/cilium.go internal/gwapi/cilium_test.go
git commit -m "feat(gwapi): Cilium label normalize + selector classify + subset (+ model fields)"
```

---

## Task 2: CNP decoder

**Files:**
- Modify: `internal/gwapi/policy_decode.go`, `internal/gwapi/policy_decode_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/gwapi/policy_decode_test.go`:

```go
func TestDecodeCNPDirectionalAndL7(t *testing.T) {
	u := specObj("CiliumNetworkPolicy", "api-allow", map[string]interface{}{
		"ingress": []interface{}{
			map[string]interface{}{
				"toPorts": []interface{}{map[string]interface{}{
					"rules": map[string]interface{}{"http": []interface{}{map[string]interface{}{"method": "GET"}}},
				}},
			},
		},
		"egress": []interface{}{
			map[string]interface{}{"toEntities": []interface{}{"world", "cluster"}},
			map[string]interface{}{"toFQDNs": []interface{}{map[string]interface{}{"matchName": "api.example.com"}}},
		},
	})
	d := Decode("CiliumNetworkPolicy", u)
	// presence-only summary, value-free
	if !strings.Contains(d.Summary, "ingress") || !strings.Contains(d.Summary, "egress") || !strings.Contains(d.Summary, "L7") {
		t.Fatalf("summary: %q", d.Summary)
	}
	if strings.ContainsAny(d.Summary, "0123456789") {
		t.Fatalf("summary leaked a value: %q", d.Summary)
	}
	// decoded details carry values
	var hasL7, hasEntities, hasFQDN bool
	for _, dt := range d.Details {
		if dt.Key == "L7" && strings.Contains(dt.Value, "http") {
			hasL7 = true
		}
		if dt.Key == "toEntities" && strings.Contains(dt.Value, "world") {
			hasEntities = true
		}
		if dt.Key == "toFQDNs" && strings.Contains(dt.Value, "api.example.com") {
			hasFQDN = true
		}
	}
	if !hasL7 || !hasEntities || !hasFQDN {
		t.Fatalf("details: %+v", d.Details)
	}
}

func TestDecodeCNPDirectionalDefaultDeny(t *testing.T) {
	u := specObj("CiliumNetworkPolicy", "deny", map[string]interface{}{
		"ingress": []interface{}{}, // empty rule list = ingress default-deny
	})
	if d := Decode("CiliumNetworkPolicy", u); d.Summary != "ingress default-deny" {
		t.Fatalf("summary: %q", d.Summary)
	}
	// CCNP uses the same decoder.
	if d := Decode("CiliumClusterwideNetworkPolicy", u); d.Summary != "ingress default-deny" {
		t.Fatalf("ccnp summary: %q", d.Summary)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestDecodeCNP -v`
Expected: FAIL — CNP not in the registry (Decode falls back to name).

- [ ] **Step 3: Implement in `internal/gwapi/policy_decode.go`**

Add the two registry entries (both kinds share one decoder):

```go
	"BackendTLSPolicy":     decodeBTLS,
	"CiliumNetworkPolicy":            decodeCNP,
	"CiliumClusterwideNetworkPolicy": decodeCNP,
```

Add `decodeCNP` (and a small `dedupStrings` helper) at the end of the file:

```go
func decodeCNP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	ing, ingFound, _ := unstructured.NestedSlice(u.Object, "spec", "ingress")
	egr, egrFound, _ := unstructured.NestedSlice(u.Object, "spec", "egress")
	if ingFound {
		if len(ing) == 0 {
			f.add("ingress default-deny")
		} else {
			f.add("ingress")
		}
	}
	if egrFound {
		if len(egr) == 0 {
			f.add("egress default-deny")
		} else {
			f.add("egress")
		}
	}

	var entities, fqdns []string
	l7 := map[string]bool{}
	rules := append(append([]interface{}{}, ing...), egr...)
	for _, r := range rules {
		rm, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		for _, key := range []string{"toEntities", "fromEntities"} {
			if e, ok, _ := unstructured.NestedStringSlice(rm, key); ok {
				entities = append(entities, e...)
			}
		}
		if fq, ok, _ := unstructured.NestedSlice(rm, "toFQDNs"); ok {
			for _, q := range fq {
				qm, _ := q.(map[string]interface{})
				if n, _ := qm["matchName"].(string); n != "" {
					fqdns = append(fqdns, n)
				}
				if p, _ := qm["matchPattern"].(string); p != "" {
					fqdns = append(fqdns, p)
				}
			}
		}
		for _, key := range []string{"toPorts", "fromPorts"} {
			tps, ok, _ := unstructured.NestedSlice(rm, key)
			if !ok {
				continue
			}
			for _, tp := range tps {
				tpm, _ := tp.(map[string]interface{})
				if rl, ok := tpm["rules"].(map[string]interface{}); ok {
					for _, proto := range []string{"http", "dns", "kafka"} {
						if _, has := rl[proto]; has {
							l7[proto] = true
						}
					}
				}
			}
		}
	}
	if ents := dedupStrings(entities); len(ents) > 0 {
		f.add("toEntities")
		f.kv("toEntities", strings.Join(ents, ", "))
	}
	if fq := dedupStrings(fqdns); len(fq) > 0 {
		f.add("toFQDNs")
		f.kv("toFQDNs", strings.Join(fq, ", "))
	}
	if len(l7) > 0 {
		f.add("L7")
		var protos []string
		for _, proto := range []string{"http", "dns", "kafka"} { // deterministic order
			if l7[proto] {
				protos = append(protos, proto)
			}
		}
		f.kv("L7", strings.Join(protos, ", "))
	}
	return f.decode()
}

func dedupStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
```

NOTE: `decodeCNP` uses `unstructured`, `strings` — both already imported in `policy_decode.go`. The `feat` helper keeps `Summary` value-free; default-deny is directional (`ingress default-deny` / `egress default-deny`), never a generic `default-deny`.

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gwapi/ -run TestDecodeCNP -v` then `go test ./internal/gwapi/` and `go vet ./internal/gwapi/`
Expected: PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/gwapi/policy_decode.go internal/gwapi/policy_decode_test.go
git commit -m "feat(gwapi): CNP/CCNP decoder (directional default-deny, L7, entities, FQDNs)"
```

---

## Task 3: `CiliumPolicyRef` builder

**Files:**
- Modify: `internal/gwapi/cilium.go`, `internal/gwapi/cilium_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/gwapi/cilium_test.go`:

```go
import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured" // add to the import block

func cnpObj(ns, name string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "CiliumNetworkPolicy",
		"metadata": map[string]interface{}{"namespace": ns, "name": name},
		"spec":     spec,
	}}
}

func TestCiliumPolicyRefSelector(t *testing.T) {
	u := cnpObj("monitoring", "grafana-allow", map[string]interface{}{
		"ingress": []interface{}{map[string]interface{}{}},
	})
	ref := CiliumPolicyRef(u, "CiliumNetworkPolicy", MatchSelector, "monitoring", "grafana", true)
	if ref.Kind != "CiliumNetworkPolicy" || ref.Namespace != "monitoring" || ref.Name != "grafana-allow" {
		t.Fatalf("ids: %+v", ref)
	}
	if ref.TargetKind != "Pods" || ref.TargetNamespace != "monitoring" || ref.TargetName != "grafana" {
		t.Fatalf("target: %+v", ref)
	}
	if !ref.Inferred || ref.Match != MatchSelector {
		t.Fatalf("inferred/match: %+v", ref)
	}
	// exprNote=true appends the honesty detail.
	var hasNote bool
	for _, d := range ref.Details {
		if d.Key == "selector note" && strings.Contains(d.Value, "matchExpressions present") {
			hasNote = true
		}
	}
	if !hasNote {
		t.Fatalf("expected matchExpressions note: %+v", ref.Details)
	}
}

func TestCiliumPolicyRefClusterWide(t *testing.T) {
	u := cnpObj("", "deny-all", map[string]interface{}{"ingress": []interface{}{}})
	ref := CiliumPolicyRef(u, "CiliumClusterwideNetworkPolicy", MatchClusterWide, "", "", false)
	if ref.Match != MatchClusterWide || ref.TargetName != "" || !ref.Inferred {
		t.Fatalf("cluster-wide: %+v", ref)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestCiliumPolicyRef -v`
Expected: FAIL — `CiliumPolicyRef` undefined.

- [ ] **Step 3: Append to `internal/gwapi/cilium.go`**

```go
// CiliumPolicyRef builds an inferred PolicyRef for a CNP/CCNP matched against a Service's
// pods. TargetKind is always "Pods" (Cilium selects endpoints; the Service is the bridge).
// exprNote appends the "matchExpressions present, not fully evaluated" honesty detail.
func CiliumPolicyRef(u *unstructured.Unstructured, kind string, match PolicyMatchKind, targetNS, targetName string, exprNote bool) PolicyRef {
	dec := Decode(kind, u)
	details := append([]PolicyDetail(nil), dec.Details...)
	if exprNote {
		details = append(details, PolicyDetail{Key: "selector note", Value: "matchExpressions present, not fully evaluated"})
	}
	return PolicyRef{
		Kind: kind, Namespace: u.GetNamespace(), Name: u.GetName(),
		TargetKind: "Pods", TargetNamespace: targetNS, TargetName: targetName,
		Summary: dec.Summary, Details: details,
		Inferred: true, Match: match,
	}
}
```

Add `"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"` to `cilium.go`'s imports (it's already imported there from Task 1).

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gwapi/ -v` then `go vet ./internal/gwapi/`
Expected: PASS (all gwapi), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/gwapi/cilium.go internal/gwapi/cilium_test.go
git commit -m "feat(gwapi): CiliumPolicyRef builder (Pods target, inferred, expr note)"
```

---

## Task 4: fleet `attachCiliumPolicies`

**Files:**
- Modify: `internal/fleet/gateway.go`
- Create: `internal/fleet/gateway_cilium_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/gateway_cilium_test.go`:

```go
package fleet

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
)

func cnpGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumnetworkpolicies"}
}
func ccnpGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumclusterwidenetworkpolicies"}
}

func cnp(ns, name string, endpointSelector map[string]interface{}, spec map[string]interface{}) *unstructured.Unstructured {
	s := map[string]interface{}{"endpointSelector": endpointSelector}
	for k, v := range spec {
		s[k] = v
	}
	meta := map[string]interface{}{"name": name}
	if ns != "" {
		meta["namespace"] = ns
	}
	kind := "CiliumNetworkPolicy"
	if ns == "" {
		kind = "CiliumClusterwideNetworkPolicy"
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "cilium.io/v2", "kind": kind, "metadata": meta, "spec": s,
	}}
}

func ciliumDiscovery() []*metav1.APIResourceList {
	return []*metav1.APIResourceList{{GroupVersion: "cilium.io/v2", APIResources: []metav1.APIResource{
		{Name: "ciliumnetworkpolicies", Namespaced: true, Kind: "CiliumNetworkPolicy"},
		{Name: "ciliumclusterwidenetworkpolicies", Namespaced: false, Kind: "CiliumClusterwideNetworkPolicy"},
	}}}
}

func TestAttachCiliumPolicies(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{
		gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList",
		cnpGVR():  "CiliumNetworkPolicyList",
		ccnpGVR(): "CiliumClusterwideNetworkPolicyList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds)
	put := func(gvr schema.GroupVersionResource, o *unstructured.Unstructured) {
		ns, _, _ := unstructured.NestedString(o.Object, "metadata", "namespace")
		if _, err := dyn.Resource(gvr).Namespace(ns).Create(context.Background(), o, metav1.CreateOptions{}); err != nil {
			t.Fatalf("seed %s: %v", gvr, err)
		}
	}
	put(gwGVR(), gw("eg", "infra"))
	put(hrGVR(), hr("share", "apps", "eg", "infra", "share-api"))
	// narrow CNP matching the share-api service selector {app: share-api}
	put(cnpGVR(), cnp("apps", "share-allow", map[string]interface{}{"matchLabels": map[string]interface{}{"app": "share-api"}},
		map[string]interface{}{"ingress": []interface{}{map[string]interface{}{}}}))
	// namespace-wide CNP (empty selector) in apps
	put(cnpGVR(), cnp("apps", "ns-deny", map[string]interface{}{}, map[string]interface{}{"egress": []interface{}{map[string]interface{}{}}}))
	// broad CCNP (empty selector) → header context
	put(ccnpGVR(), cnp("", "cluster-deny", map[string]interface{}{}, map[string]interface{}{"ingress": []interface{}{map[string]interface{}{}}}))

	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"},
		Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Selector: map[string]string{"app": "share-api"}, Ports: []corev1.ServicePort{{Port: 80}}}}
	typed := typedfake.NewSimpleClientset(svc)
	typed.Resources = ciliumDiscovery()

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	cnps := topo.Routes[0].Services[0].CNPs
	var hasSelector, hasNsWide bool
	for _, p := range cnps {
		if p.Name == "share-allow" && p.Match == "selector" {
			hasSelector = true
		}
		if p.Name == "ns-deny" && p.Match == "namespace-wide" {
			hasNsWide = true
		}
	}
	if !hasSelector {
		t.Fatalf("selector CNP not attached: %+v", cnps)
	}
	if !hasNsWide {
		t.Fatalf("namespace-wide CNP not attached: %+v", cnps)
	}
	if len(topo.ClusterPolicies) != 1 || topo.ClusterPolicies[0].Name != "cluster-deny" || topo.ClusterPolicies[0].Match != "cluster-wide" {
		t.Fatalf("cluster-wide CCNP not in header bucket: %+v", topo.ClusterPolicies)
	}
}

func TestAttachCiliumExpressionsOnlyWarns(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{
		gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList", cnpGVR(): "CiliumNetworkPolicyList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds)
	put := func(gvr schema.GroupVersionResource, o *unstructured.Unstructured) {
		ns, _, _ := unstructured.NestedString(o.Object, "metadata", "namespace")
		_, _ = dyn.Resource(gvr).Namespace(ns).Create(context.Background(), o, metav1.CreateOptions{})
	}
	put(gwGVR(), gw("eg", "infra"))
	put(hrGVR(), hr("share", "apps", "eg", "infra", "share-api"))
	put(cnpGVR(), cnp("apps", "expr-only", map[string]interface{}{"matchExpressions": []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists"}}},
		map[string]interface{}{"ingress": []interface{}{map[string]interface{}{}}}))

	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"},
		Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "share-api"}}}
	typed := typedfake.NewSimpleClientset(svc)
	// only CNP served; CCNP "not installed"
	typed.Resources = []*metav1.APIResourceList{{GroupVersion: "cilium.io/v2", APIResources: []metav1.APIResource{
		{Name: "ciliumnetworkpolicies", Namespaced: true, Kind: "CiliumNetworkPolicy"},
	}}}

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, _ := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if len(topo.Routes[0].Services[0].CNPs) != 0 {
		t.Fatalf("expressions-only must not attach: %+v", topo.Routes[0].Services[0].CNPs)
	}
	var warned, notInstalled bool
	for _, w := range topo.Warnings {
		if strings.Contains(w, "matchExpressions-only selector not evaluated") {
			warned = true
		}
		if strings.Contains(w, "CiliumClusterwideNetworkPolicy CRD not installed") {
			notInstalled = true
		}
	}
	if !warned {
		t.Fatalf("want expressions-only warning: %+v", topo.Warnings)
	}
	if !notInstalled {
		t.Fatalf("want CCNP not-installed warning: %+v", topo.Warnings)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestAttachCilium -v`
Expected: FAIL — CNPs empty / `attachCiliumPolicies` undefined.

- [ ] **Step 3: Implement in `internal/fleet/gateway.go`**

Add `cilium.io` to `policyCandidateVersions`:

```go
var policyCandidateVersions = map[string][]string{
	envoyGroup: {"v1alpha1"},
	gwGroup:    {"v1", "v1alpha3", "v1alpha2"},
	ciliumGroup: {"v2"},
}
```

Add the group const + kind table near `policyKinds`:

```go
const ciliumGroup = "cilium.io"

var ciliumPolicyKinds = []struct {
	Kind, Resource string
	Cluster        bool
}{
	{"CiliumNetworkPolicy", "ciliumnetworkpolicies", false},
	{"CiliumClusterwideNetworkPolicy", "ciliumclusterwidenetworkpolicies", true},
}
```

In `resolveBackends`, store the Service selector on the node. Find the block that sets `sn.Type`/`sn.Port` after a successful `Get` and add the selector line:

```go
		sn.Resolved = true
		sn.Type = string(svc.Spec.Type)
		sn.Selector = svc.Spec.Selector
```

Add the call after `c.attachGatewayPolicies(ctx, &topo)` in `GetGatewayTopology`:

```go
	c.attachGatewayPolicies(ctx, &topo)
	c.attachCiliumPolicies(ctx, &topo)
	return topo, nil
```

Add the two methods (alongside `attachGatewayPolicies`):

```go
// attachCiliumPolicies lists CNP/CCNP and attaches them by the inferred label heuristic.
// Reuses the served-resource discovery + two warning classes. Inferred=true throughout.
func (c *ClusterConn) attachCiliumPolicies(ctx context.Context, topo *gwapi.Topology) {
	for _, ck := range ciliumPolicyKinds {
		gvr, ok := c.servedResourceGVR(ciliumGroup, ck.Resource)
		if !ok {
			topo.Warnings = append(topo.Warnings, ck.Kind+" CRD not installed")
			continue
		}
		list, err := c.dyn.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err != nil {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("could not list %s: %v", ck.Kind, err))
			continue
		}
		for i := range list.Items {
			u := &unstructured.Unstructured{Object: list.Items[i].Object}
			attachOneCiliumPolicy(u, ck.Kind, ck.Cluster, topo)
		}
	}
}

// attachOneCiliumPolicy classifies a policy's selector once, then maps class + kind to a
// PolicyMatchKind and routes it to ServiceNode.CNPs / Topology.ClusterPolicies / a warning.
func attachOneCiliumPolicy(u *unstructured.Unstructured, kind string, cluster bool, topo *gwapi.Topology) {
	sel, _, _ := unstructured.NestedMap(u.Object, "spec", "endpointSelector")
	class, labels, hasExpr := gwapi.ClassifyCiliumSelector(sel)
	polNS := u.GetNamespace()

	switch class {
	case gwapi.SelectorExpressionsOnly:
		topo.Warnings = append(topo.Warnings, fmt.Sprintf("%s %s/%s: matchExpressions-only selector not evaluated", kind, polNS, u.GetName()))
		return
	case gwapi.SelectorEmpty:
		if cluster {
			topo.ClusterPolicies = append(topo.ClusterPolicies, gwapi.CiliumPolicyRef(u, kind, gwapi.MatchClusterWide, "", "", false))
			return
		}
		// namespace-wide CNP: every Service in the policy's namespace.
		for ri := range topo.Routes {
			for si := range topo.Routes[ri].Services {
				s := &topo.Routes[ri].Services[si]
				if s.Namespace == polNS {
					s.CNPs = append(s.CNPs, gwapi.CiliumPolicyRef(u, kind, gwapi.MatchNamespaceWide, s.Namespace, s.Name, false))
				}
			}
		}
	case gwapi.SelectorLabels:
		for ri := range topo.Routes {
			for si := range topo.Routes[ri].Services {
				s := &topo.Routes[ri].Services[si]
				if !cluster && s.Namespace != polNS {
					continue // a namespaced CNP only governs its own namespace
				}
				if gwapi.LabelsSubset(labels, s.Selector) {
					s.CNPs = append(s.CNPs, gwapi.CiliumPolicyRef(u, kind, gwapi.MatchSelector, s.Namespace, s.Name, hasExpr))
				}
			}
		}
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/fleet/ -run TestAttachCilium -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`
Expected: PASS (pre-existing topology tests still pass — the Cilium pass adds "CRD not installed" warnings they don't assert on), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/gateway.go internal/fleet/gateway_cilium_test.go
git commit -m "feat(fleet): attach inferred Cilium CNP/CCNP (selector/namespace-wide/cluster-wide)"
```

---

## Task 5: appbridge DTO

**Files:**
- Modify: `internal/appbridge/gateway_dto.go`, `internal/appbridge/gateway_service_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/appbridge/gateway_service_test.go`:

```go
func TestGatewayTopologyDTOCilium(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway: gwapi.GatewayNode{Namespace: "infra", Name: "eg"},
		Routes: []gwapi.RouteNode{{
			Namespace: "apps", Name: "share",
			Services: []gwapi.ServiceNode{{Namespace: "apps", Name: "share-api", Resolved: true,
				CNPs: []gwapi.PolicyRef{{Kind: "CiliumNetworkPolicy", Namespace: "apps", Name: "share-allow", TargetKind: "Pods", TargetNamespace: "apps", TargetName: "share-api", Summary: "ingress", Inferred: true, Match: gwapi.MatchSelector}}}},
		}},
		ClusterPolicies: []gwapi.PolicyRef{{Kind: "CiliumClusterwideNetworkPolicy", Name: "cluster-deny", Summary: "ingress default-deny", Inferred: true, Match: gwapi.MatchClusterWide}},
	}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")

	cnps := d.Routes[0].Services[0].CNPs
	if len(cnps) != 1 || cnps[0].Match != "selector" || cnps[0].TargetKind != "Pods" || !cnps[0].Inferred {
		t.Fatalf("service cnps DTO: %+v", cnps)
	}
	if len(d.ClusterPolicies) != 1 || d.ClusterPolicies[0].Match != "cluster-wide" || d.ClusterPolicies[0].Kind != "CiliumClusterwideNetworkPolicy" {
		t.Fatalf("cluster policies DTO: %+v", d.ClusterPolicies)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGatewayTopologyDTOCilium -v`
Expected: FAIL — `PolicyRefDTO` lacks `Match`; `TopologyDTO` lacks `ClusterPolicies`.

- [ ] **Step 3: Modify `internal/appbridge/gateway_dto.go`**

Add `Match` to `PolicyRefDTO` (after `Inferred`):

```go
	Inferred          bool              `json:"inferred"`
	Match             string            `json:"match"`
```

Add `ClusterPolicies` to `TopologyDTO`:

```go
type TopologyDTO struct {
	Gateway         GatewayNodeDTO `json:"gateway"`
	Routes          []RouteNodeDTO `json:"routes"`
	ClusterPolicies []PolicyRefDTO `json:"clusterPolicies,omitempty"`
	Warnings        []string       `json:"warnings,omitempty"`
	Error           string         `json:"error,omitempty"`
}
```

In `policyDTOs`, map `Match`:

```go
		out = append(out, PolicyRefDTO{
			Kind: p.Kind, Namespace: p.Namespace, Name: p.Name,
			TargetKind: p.TargetKind, TargetNamespace: p.TargetNamespace, TargetName: p.TargetName, TargetSectionName: p.TargetSectionName,
			Summary: p.Summary, Details: details, Inferred: p.Inferred, Match: string(p.Match),
		})
```

In `toTopologyDTO`, set `ClusterPolicies` on the output. Find the `out := TopologyDTO{...}` construction and add the field:

```go
	out := TopologyDTO{Gateway: gd, Warnings: t.Warnings, ClusterPolicies: policyDTOs(t.ClusterPolicies)}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/appbridge/ -v` then `go vet ./internal/appbridge/`
Expected: PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gateway_dto.go internal/appbridge/gateway_service_test.go
git commit -m "feat(appbridge): policy DTO match field + topology clusterPolicies"
```

---

## Task 6: frontend store types + inferred `PolicyChip` styling

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/cluster/PolicyChip.tsx`, `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx`

- [ ] **Step 1: Update store types in `cmd/klyx/frontend/src/store/fleet.ts`**

Replace the `PolicyRefDTO` line to add `match`:

```ts
export type PolicyRefDTO = { kind: string; namespace: string; name: string; targetKind: string; targetNamespace: string; targetName: string; targetSectionName: string; summary: string; details: PolicyDetailDTO[]; inferred: boolean; match: string };
```

Replace the `TopologyDTO` line to add `clusterPolicies`:

```ts
export type TopologyDTO = { gateway: GatewayNodeDTO; routes: RouteNodeDTO[]; clusterPolicies?: PolicyRefDTO[]; warnings?: string[]; error?: string };
```

- [ ] **Step 2: Write the failing `PolicyChip` test**

Add to `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx`:

```tsx
const cnp: PolicyRefDTO = {
  kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow",
  targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "",
  summary: "ingress + egress", details: [{ key: "L7", value: "http" }],
  inferred: true, match: "selector",
};

describe("PolicyChip inferred (Cilium)", () => {
  it("renders the CNP abbreviation, ~ marker, and a dashed border", () => {
    const { getByText, container } = render(<PolicyChip p={cnp} />);
    expect(getByText(/CNP/)).toBeTruthy();
    expect(getByText("~")).toBeTruthy();
    // the inner chip span carries a dashed border when inferred
    const dashed = container.querySelector('span[style*="dashed"]');
    expect(dashed).toBeTruthy();
  });

  it("tooltip leads with the inference honesty note + match basis", () => {
    const { getByText } = render(<PolicyChip p={cnp} />);
    fireEvent.mouseEnter(getByText(/CNP/));
    expect(getByText(/inferred: matched by Service selector, not a Gateway API attachment/i)).toBeTruthy();
    expect(getByText(/via: selector/i)).toBeTruthy();
  });
});
```

Ensure the test file imports `fireEvent` (add to the existing `@testing-library/react` import if missing).

- [ ] **Step 3: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/PolicyChip.test.tsx`
Expected: FAIL — no dashed border, no honesty note.

- [ ] **Step 4: Update `cmd/klyx/frontend/src/cluster/PolicyChip.tsx`**

Add CNP/CCNP colours to the `COLOUR` map (muted, distinct from the precise hues):

```ts
  BackendTLSPolicy: { fg: "#ec6547", bg: "rgba(236,101,71,.16)" },
  CiliumNetworkPolicy: { fg: "#8b949e", bg: "rgba(139,148,158,.10)" },
  CiliumClusterwideNetworkPolicy: { fg: "#8b949e", bg: "rgba(139,148,158,.10)" },
```

Give the inner chip span a dashed border when inferred. Change the inner `<span>`'s `style` to add `border`:

```tsx
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 8,
          padding: "1px 5px",
          borderRadius: 3,
          fontFamily: "var(--font-mono)",
          color: c.fg,
          background: c.bg,
          border: p.inferred ? `0.5px dashed ${c.fg}` : "0.5px solid transparent",
          cursor: "default",
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
```

Lead the tooltip with the honesty note when inferred. Replace the tooltip's identity `<div>` block with:

```tsx
          {p.inferred && (
            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 4, fontStyle: "italic" }}>
              inferred: matched by Service selector, not a Gateway API attachment{p.match ? ` · via: ${p.match}` : ""}
            </div>
          )}
          <div style={{ fontWeight: 600, marginBottom: p.details.length ? 4 : 0 }}>
            {p.kind} {p.namespace}/{p.name}
          </div>
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/PolicyChip.test.tsx`
Expected: PASS (existing precise-chip tests still pass — the border for non-inferred is `solid transparent`, visually unchanged).

- [ ] **Step 6: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/cluster/PolicyChip.tsx cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx
git commit -m "feat(ui): inferred Cilium chip styling (dashed/muted/~) + honesty tooltip + match field"
```

---

## Task 7: `NetworkTopology` — pods-box chips, header cluster-wide group, detail sub-group

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`, `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`:

```tsx
  it("renders inferred CNP chips on the pods box and cluster-wide CCNPs in the header", () => {
    const cnp = { kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow", targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "ingress", details: [], inferred: true, match: "selector" };
    const ccnp = { kind: "CiliumClusterwideNetworkPolicy", namespace: "", name: "cluster-deny", targetKind: "Pods", targetNamespace: "", targetName: "", targetSectionName: "", summary: "ingress default-deny", details: [], inferred: true, match: "cluster-wide" };
    const withCilium: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], cnps: [cnp] }] }],
      clusterPolicies: [ccnp],
      warnings: [],
    };
    seed(withCilium);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText("CNP")).toBeTruthy();          // pods box (exact - avoids matching "CCNP")
    expect(getByText(/cluster-wide policies/i)).toBeTruthy(); // header group label
    expect(getByText("CCNP")).toBeTruthy();         // header chip (exact)
  });

  it("route detail shows inferred CNPs with honest pod-target wording", () => {
    const cnp = { kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow", targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "ingress", details: [{ key: "L7", value: "http" }], inferred: true, match: "selector" };
    const withCilium: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], cnps: [cnp] }] }],
      warnings: [],
    };
    seed(withCilium);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share"));
    expect(getByText(/inferred network policies/i)).toBeTruthy();
    expect(getByText(/Pods selected via Service apps\/share-api/)).toBeTruthy();
    expect(getByText(/Inferred via: selector/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx -t "inferred"`
Expected: FAIL.

- [ ] **Step 3: Render inferred chips on the pods box**

In `NetworkTopology.tsx`, the pods box currently is:

```tsx
                <div style={nb}>
                  <div style={lab}>pods</div>
                  <div style={nm}>{r.pods.unknown ? "unknown" : `${r.pods.ready} / ${r.pods.total}`}</div>
                </div>
```

Replace with (the primary service's CNPs render below the count):

```tsx
                <div style={nb}>
                  <div style={lab}>pods</div>
                  <div style={nm}>{r.pods.unknown ? "unknown" : `${r.pods.ready} / ${r.pods.total}`}</div>
                  {svc && svc.cnps.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {svc.cnps.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
                </div>
```

- [ ] **Step 4: Add the header CLUSTER-WIDE POLICIES group**

After the gateway `policies` group block in the header (the `{t.gateway.policies.length > 0 && (...)}` block, before the `<div style={{ flex: 1 }} />` spacer), add:

```tsx
        {t.clusterPolicies && t.clusterPolicies.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--color-text-tertiary)" }}>cluster-wide policies</span>
            {t.clusterPolicies.map((p) => (
              <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
            ))}
          </div>
        )}
```

- [ ] **Step 5: Add the inferred sub-group to `RouteDetail`**

In the `RouteDetail` "attached policies" section, after the precise-policies IIFE block (`})()}`) and before the existing `Gateway policies are shown in the topology header.` hint `<div>`, insert the inferred sub-group:

```tsx
        {(() => {
          const cnps = route.services.flatMap((s) => s.cnps);
          if (cnps.length === 0) return null;
          return (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>inferred network policies</div>
              {cnps.map((p) => (
                <div key={`${p.kind}/${p.namespace}/${p.name}`} style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600 }}>{`${p.kind} ${p.namespace}/${p.name}`}</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Target: Pods selected via Service ${p.targetNamespace}/${p.targetName}`}</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Inferred via: ${p.match}`}</div>
                  {p.summary && <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Features: ${p.summary}`}</div>}
                  {p.details.map((d, i) => (
                    <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-secondary)" }}>{d.key}: {d.value}</div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>cluster-wide policies are shown in the topology header.</div>
            </div>
          );
        })()}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx` then `npx vitest run`
Expected: PASS (whole suite).

- [ ] **Step 7: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): inferred CNP chips on pods box + cluster-wide header group + detail sub-group"
```

---

## Task 8: bindings + full verification + native handoff

**Files:** none new (regenerate bindings, run gates).

- [ ] **Step 1: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, clean.

- [ ] **Step 2: Regenerate bindings + frontend gate + native build**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
- vitest green; **`tsc --noEmit` clean** (the new `match` field + `clusterPolicies` compile against the regenerated `GatewayService` binding); build exit 0 (ignore `ld: warning` + the known `cmd/klyx/build/ios` scaffold artifact). If tsc errors, READ the error, fix the source (not by loosening types), re-run.

NOTE: `cmd/klyx/frontend/bindings/` is gitignored — nothing to commit from binding regen.

- [ ] **Step 3: Clean up build output, confirm clean tree**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
rm -f klyx cmd/klyx/bin/klyx 2>/dev/null; git status --short
```
Expected: clean tree.

- [ ] **Step 4: Native handoff (owner, homelab-nelli)**

Apply synthetic Cilium policies and confirm in Network → external-gateway:
- a **narrow** CNP (`matchLabels: {app: grafana}`, namespace monitoring) → a `~ CNP` chip on the grafana **pods** box, dashed/muted, tooltip leading with the inferred-honesty note + `via: selector`.
- a **namespace-wide** CNP (empty `endpointSelector`, an ingress default-deny in monitoring) → `~ CNP` chips on the pods box of every monitoring lane (`via: namespace-wide`).
- a **narrow CCNP** (`matchLabels` matching a backend) → a `~ CCNP` chip on that pods box.
- a **broad CCNP** (empty selector, cluster default-deny) → a `CLUSTER-WIDE POLICIES` chip in the header, NOT sprayed on lanes.
- a **matchExpressions-only** CNP → no chip, a warning surfaced.
- route detail "inferred network policies" sub-group shows `Pods selected via Service <ns>/<name>` + `Inferred via: <match>`, visually divided from the precise policies, with the cluster-wide-header hint.

There is no merge step here — gate on native verification, then `finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** §1 model (`PolicyMatchKind`, `Match`, `ClusterPolicies`, `ServiceNode.Selector`) → T1/T4/T5. §2 `NormalizeCiliumLabels`/`ClassifyCiliumSelector`/`LabelsSubset` → T1; CNP decoder + directional default-deny → T2; `CiliumPolicyRef` + matchExpressions note → T3. §3 fleet separate pass, classify-once, kind→Match mapping, two warning classes, `cilium.io v2` → T4. §4 DTO (`match`, `clusterPolicies`) → T5. §5 pods-box chips, dashed/muted inferred styling, honesty tooltip, header cluster-wide group, detail sub-group, honest pod wording, cluster-wide hint → T6/T7. §6 testing → each task; native handoff → T8.
- **Seam preserved:** precise policies (`Policies`, `Match==""`) untouched; inferred only ever sets `Inferred=true` + a `Match`. `ServiceNode.Policies` (precise) and `ServiceNode.CNPs` (inferred) stay separate buckets.
- **Honesty ladder:** classify-once in `attachOneCiliumPolicy`; empty→namespace-wide (CNP) / cluster-wide (CCNP); matchLabels→subset; expressions-only→warning+skip.
- **`ServiceNode.Selector` is internal** (Go model only, populated in `resolveBackends`); it is NOT added to `ServiceNodeDTO`, so no binding/TS change and no leak of selector internals to the UI.
- **Type consistency:** Go `PolicyRef.Match PolicyMatchKind` ↔ DTO `Match string` (json `match`) ↔ TS `match: string`; `Topology.ClusterPolicies` ↔ `TopologyDTO.ClusterPolicies` (json `clusterPolicies`) ↔ TS `clusterPolicies?`. `SelectorClass`/`MatchSelector`/`MatchNamespaceWide`/`MatchClusterWide`/`CiliumPolicyRef`/`ClassifyCiliumSelector`/`LabelsSubset`/`NormalizeCiliumLabels` named identically across tasks.
- **Decoder shared:** one `decodeCNP` registered for both `CiliumNetworkPolicy` and `CiliumClusterwideNetworkPolicy`.
