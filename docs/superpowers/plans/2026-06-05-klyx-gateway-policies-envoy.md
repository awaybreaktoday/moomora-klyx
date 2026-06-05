# M5-b-i: Gateway Policy Attachment (Envoy precise) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach Envoy Gateway / Gateway-API policies (CTP, BTP, SecurityPolicy, EnvoyExtensionPolicy, BackendTLSPolicy) to the topology by their `targetRef`, decode each into a value-free chip summary + decoded detail rows, and render chips on the gateway/route/service nodes plus an "attached policies" section in the route detail panel.

**Architecture:** Pure `internal/gwapi` gains `PolicyTargets` (parse targetRefs), a per-kind decoder registry producing `{Summary, Details}`, and `BuildPolicyRefs`/`AttachPolicies` (fan-out + namespace defaulting + node matching). `internal/fleet` lists the five policy resources via discovery (informational warning when a CRD is absent, operational warning when a served list fails), builds refs, and attaches. The appbridge DTO + the React `NetworkTopology` carry it through as a dumb renderer. Snapshot, no watch.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic + typed fakes, fake discovery), Wails v3 bound services, React 19 + TS 6 + Vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-05-klyx-gateway-policies-design.md`. Cilium CNP/CCNP (inferred) is M5-b-ii, a separate plan — this plan never sets `Inferred=true`.

---

## Context the engineer needs

- **The truth hierarchy:** chip = feature presence (NEVER a decoded value), tooltip/detail = decoded values, YAML = source of truth. The `feat` helper in Task 2 enforces value-free summaries structurally.
- **Attach by `targetRef`, not by kind.** A BTP/SP/EEP can target a Gateway OR an HTTPRoute; CTP targets a Gateway; BackendTLSPolicy targets a Service. The node a policy lands on is decided by `targetRef.kind`+name, not the policy's own kind.
- **targetRef namespace defaulting:** omitted → the policy's namespace; present → the explicit value. Resolved in `BuildPolicyRefs`.
- **Fan-out:** one policy with `spec.targetRefs[]` (plural) yields one `PolicyRef` per target, sharing the decoded summary/details.
- **Version resolution is per-resource, not per-group.** `gateway.networking.k8s.io`'s preferred version is `v1` (gateways/httproutes), but `backendtlspolicies` is served at `v1alpha3`. So policy GVRs are resolved by probing discovery for the resource across candidate versions (`servedResourceGVR`), NOT via the group's preferred version.
- **Two warning classes (distinct strings):** CRD group/resource not served → `"<Kind> CRD not installed"` (informational); served but list fails (e.g. RBAC forbidden) → `"could not list <Kind>: <err>"` (operational).
- **Existing model is additive-safe:** `PolicyRef` currently has `{Kind, Name, Summary, Inferred}`; appbridge's `policyDTOs` reads those four. Adding fields does not break it. `GatewayNode.Policies` / `RouteNode.Policies` already exist (empty). `ServiceNode` gains a new `Policies` field, kept separate from the reserved `CNPs`.
- **Frontend renderer:** gateway-level policy chips render once in the topology header (not per lane); route chips on the httproute box; service chips on the service box; tooltip = first 2-4 detail rows via the chip's `title`; the route detail panel gets an "attached policies" section + a one-line hint that gateway policies live in the header.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gwapi/model.go` | `PolicyRef` fields, `PolicyDetail`, `PolicyDecode`, `TargetRef`, `ServiceNode.Policies` | Modify |
| `internal/gwapi/policy.go` | `PolicyTargets`, `BuildPolicyRefs`, `AttachPolicies` | Create |
| `internal/gwapi/policy_decode.go` | decoder registry + 5 decoders + `Decode` + `feat` helper | Create |
| `internal/gwapi/policy_test.go` | targets/attach/fan-out/ns-default tests | Create |
| `internal/gwapi/policy_decode_test.go` | per-kind decoder + invariant tests | Create |
| `internal/fleet/gateway.go` | policy pass: `servedResourceGVR`, `attachPolicies`, two warnings | Modify |
| `internal/fleet/gateway_policy_test.go` | five-GVR fake + warnings tests | Create |
| `internal/appbridge/gateway_dto.go` | `PolicyDetailDTO`, `PolicyRefDTO` fields, `ServiceNodeDTO.Policies`, mapper | Modify |
| `internal/appbridge/gateway_service_test.go` | DTO mapping incl. details + target + service policies | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | TS `PolicyRefDTO` fields, `PolicyDetailDTO`, `ServiceNodeDTO.policies` | Modify |
| `cmd/klyx/frontend/src/cluster/PolicyChip.tsx` | chip + tooltip + colour/label by kind | Create |
| `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx` | chip render + tooltip tests | Create |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx` | chips on header/route/service + detail panel section | Modify |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` | chip + detail-section tests | Modify |

---

## Task 1: `gwapi` model + `PolicyTargets`

**Files:**
- Modify: `internal/gwapi/model.go`
- Create: `internal/gwapi/policy.go`, `internal/gwapi/policy_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gwapi/policy_test.go`:

```go
package gwapi

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func polObj(kind, ns, name string, targetRefs []interface{}, singleTargetRef map[string]interface{}, spec map[string]interface{}) *unstructured.Unstructured {
	s := map[string]interface{}{}
	for k, v := range spec {
		s[k] = v
	}
	if targetRefs != nil {
		s["targetRefs"] = targetRefs
	}
	if singleTargetRef != nil {
		s["targetRef"] = singleTargetRef
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1",
		"kind":       kind,
		"metadata":   map[string]interface{}{"namespace": ns, "name": name},
		"spec":       s,
	}}
}

func tref(kind, name, ns, section string) map[string]interface{} {
	m := map[string]interface{}{"kind": kind, "name": name, "group": "gateway.networking.k8s.io"}
	if ns != "" {
		m["namespace"] = ns
	}
	if section != "" {
		m["sectionName"] = section
	}
	return m
}

func TestPolicyTargetsPluralAndSingular(t *testing.T) {
	u := polObj("BackendTrafficPolicy", "apps", "btp", []interface{}{
		tref("HTTPRoute", "r1", "", "https"),
		tref("HTTPRoute", "r2", "other", ""),
	}, nil, nil)
	ts := PolicyTargets(u)
	if len(ts) != 2 || ts[0].Kind != "HTTPRoute" || ts[0].Name != "r1" || ts[0].SectionName != "https" {
		t.Fatalf("targets[0]: %+v", ts)
	}
	if ts[1].Namespace != "other" {
		t.Fatalf("targets[1] ns: %+v", ts[1])
	}

	// Legacy singular targetRef.
	u2 := polObj("ClientTrafficPolicy", "infra", "ctp", nil, tref("Gateway", "eg", "", ""), nil)
	ts2 := PolicyTargets(u2)
	if len(ts2) != 1 || ts2[0].Kind != "Gateway" || ts2[0].Name != "eg" {
		t.Fatalf("singular: %+v", ts2)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestPolicyTargets -v`
Expected: FAIL — `PolicyTargets` / `TargetRef` undefined.

- [ ] **Step 3: Add model types to `internal/gwapi/model.go`**

Replace the existing `PolicyRef` struct:

```go
type PolicyRef struct {
	Kind, Name, Summary string
	Inferred            bool
}
```

with the reshaped version + the new helper types (place them where `PolicyRef` was):

```go
type PolicyRef struct {
	Kind, Namespace, Name string

	// Target metadata - first-class, NOT encoded in Details.
	TargetKind, TargetNamespace, TargetName, TargetSectionName string

	Summary  string         // chip text: feature presence only, never values
	Details  []PolicyDetail // panel/tooltip rows: decoded values, deterministic order
	Inferred bool           // false for all M5-b-i Envoy policies; reserved for Cilium (M5-b-ii)
}

// PolicyDetail is one decoded key/value row (e.g. "retries" -> "3").
type PolicyDetail struct{ Key, Value string }

// PolicyDecode is what a per-kind decoder returns.
type PolicyDecode struct {
	Summary string
	Details []PolicyDetail
}

// TargetRef is a policy's targetRef (Namespace holds the raw value; empty until
// resolved by BuildPolicyRefs, which defaults it to the policy's namespace).
type TargetRef struct{ Group, Kind, Namespace, Name, SectionName string }
```

Add a `Policies` field to `ServiceNode` (keep `CNPs` for M5-b-ii):

```go
type ServiceNode struct {
	Namespace, Name, Type string
	Port                  int32
	Policies              []PolicyRef // M5-b-i: precise (BackendTLSPolicy)
	CNPs                  []PolicyRef // M5-b-ii: inferred Cilium; empty here
	Resolved              bool        // false when the Service could not be read
}
```

- [ ] **Step 4: Implement `internal/gwapi/policy.go`**

```go
package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// PolicyTargets reads spec.targetRefs[] plus the legacy singular spec.targetRef.
// Namespace holds the raw targetRef.namespace (empty when omitted).
func PolicyTargets(u *unstructured.Unstructured) []TargetRef {
	var out []TargetRef
	add := func(m map[string]interface{}) {
		t := TargetRef{}
		t.Group, _ = m["group"].(string)
		t.Kind, _ = m["kind"].(string)
		t.Name, _ = m["name"].(string)
		t.Namespace, _ = m["namespace"].(string)
		t.SectionName, _ = m["sectionName"].(string)
		out = append(out, t)
	}
	refs, _, _ := unstructured.NestedSlice(u.Object, "spec", "targetRefs")
	for _, r := range refs {
		if m, ok := r.(map[string]interface{}); ok {
			add(m)
		}
	}
	if single, ok, _ := unstructured.NestedMap(u.Object, "spec", "targetRef"); ok {
		add(single)
	}
	return out
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/gwapi/ -run TestPolicyTargets -v` then `go build ./...`
Expected: PASS; build clean (the additive model change doesn't break appbridge's `policyDTOs`, which only reads Kind/Name/Summary/Inferred).

- [ ] **Step 6: Commit**

```bash
git add internal/gwapi/model.go internal/gwapi/policy.go internal/gwapi/policy_test.go
git commit -m "feat(gwapi): policy model + PolicyTargets (targetRefs + legacy singular)"
```

---

## Task 2: decoder registry (5 decoders + `Decode` + value-free invariant)

**Files:**
- Create: `internal/gwapi/policy_decode.go`, `internal/gwapi/policy_decode_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gwapi/policy_decode_test.go`:

```go
package gwapi

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func specObj(kind, name string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     kind,
		"metadata": map[string]interface{}{"name": name},
		"spec":     spec,
	}}
}

func TestDecodeBTPFeaturesAndValues(t *testing.T) {
	u := specObj("BackendTrafficPolicy", "backend-retries", map[string]interface{}{
		"retry":   map[string]interface{}{"numRetries": int64(3), "perRetry": map[string]interface{}{"timeout": "10s"}},
		"timeout": map[string]interface{}{"http": map[string]interface{}{"requestTimeout": "30s"}},
	})
	d := Decode("BackendTrafficPolicy", u)
	if d.Summary != "retries + timeout" {
		t.Fatalf("summary: %q", d.Summary)
	}
	// Summary must be value-free.
	if strings.ContainsAny(d.Summary, "0123456789") {
		t.Fatalf("summary leaked a value: %q", d.Summary)
	}
	// Details carry decoded values in deterministic order.
	want := []PolicyDetail{{"retries", "3"}, {"per try timeout", "10s"}, {"request timeout", "30s"}}
	if len(d.Details) != len(want) {
		t.Fatalf("details: %+v", d.Details)
	}
	for i := range want {
		if d.Details[i] != want[i] {
			t.Fatalf("details[%d] = %+v want %+v", i, d.Details[i], want[i])
		}
	}
}

func TestDecodeSPPresenceOnly(t *testing.T) {
	u := specObj("SecurityPolicy", "edge-auth", map[string]interface{}{
		"jwt":  map[string]interface{}{"providers": []interface{}{}},
		"cors": map[string]interface{}{},
	})
	d := Decode("SecurityPolicy", u)
	if d.Summary != "jwt + cors" {
		t.Fatalf("summary: %q", d.Summary)
	}
}

func TestDecodeFallbackToName(t *testing.T) {
	// Kind known but no recognised feature -> Summary = name, Details empty.
	u := specObj("BackendTrafficPolicy", "mystery", map[string]interface{}{"somethingNew": true})
	d := Decode("BackendTrafficPolicy", u)
	if d.Summary != "mystery" || len(d.Details) != 0 {
		t.Fatalf("known-no-feature fallback: %+v", d)
	}
	// Kind unknown -> Summary = name (defensive drift guard).
	u2 := specObj("WeirdPolicy", "huh", map[string]interface{}{"x": 1})
	if d2 := Decode("WeirdPolicy", u2); d2.Summary != "huh" || len(d2.Details) != 0 {
		t.Fatalf("unknown-kind fallback: %+v", d2)
	}
}

func TestDecodeBTLSAndEEP(t *testing.T) {
	btls := specObj("BackendTLSPolicy", "keycloak-tls", map[string]interface{}{
		"validation": map[string]interface{}{"hostname": "keycloak.svc", "wellKnownCACertificates": "System"},
	})
	d := Decode("BackendTLSPolicy", btls)
	if d.Summary != "hostname + well-known-ca" {
		t.Fatalf("btls summary: %q", d.Summary)
	}
	if d.Details[0] != (PolicyDetail{"hostname", "keycloak.svc"}) {
		t.Fatalf("btls details: %+v", d.Details)
	}

	eep := specObj("EnvoyExtensionPolicy", "ext", map[string]interface{}{
		"extProc": []interface{}{map[string]interface{}{"backendRefs": []interface{}{}}},
	})
	if d := Decode("EnvoyExtensionPolicy", eep); d.Summary != "ext-proc" {
		t.Fatalf("eep summary: %q", d.Summary)
	}
}

func TestDecodeNeverPanicsOnMalformed(t *testing.T) {
	for _, kind := range []string{"ClientTrafficPolicy", "BackendTrafficPolicy", "SecurityPolicy", "EnvoyExtensionPolicy", "BackendTLSPolicy"} {
		u := &unstructured.Unstructured{Object: map[string]interface{}{"kind": kind, "metadata": map[string]interface{}{"name": "x"}, "spec": "not-a-map"}}
		_ = Decode(kind, u) // must not panic
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestDecode -v`
Expected: FAIL — `Decode` undefined.

- [ ] **Step 3: Implement `internal/gwapi/policy_decode.go`**

```go
package gwapi

import (
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// PolicyDecoder turns a policy unstructured into a PolicyDecode.
type PolicyDecoder func(u *unstructured.Unstructured) PolicyDecode

var policyDecoders = map[string]PolicyDecoder{
	"ClientTrafficPolicy":  decodeCTP,
	"BackendTrafficPolicy": decodeBTP,
	"SecurityPolicy":       decodeSP,
	"EnvoyExtensionPolicy": decodeEEP,
	"BackendTLSPolicy":     decodeBTLS,
}

// Decode runs the kind's decoder. Fallback ladder: a decoder that finds no
// feature (empty Summary), or an unknown kind, yields Summary = policy name,
// Details = nil. The unknown-kind rung is a defensive drift guard - the fleet
// pass only lists the five known kinds.
func Decode(kind string, u *unstructured.Unstructured) PolicyDecode {
	dec, ok := policyDecoders[kind]
	if !ok {
		return PolicyDecode{Summary: u.GetName()}
	}
	d := dec(u)
	if d.Summary == "" {
		return PolicyDecode{Summary: u.GetName()}
	}
	return d
}

// feat accumulates ordered feature names + decoded detail rows. Summary is built
// from feature names ONLY, so decoded values can never leak into it.
type feat struct {
	features []string
	details  []PolicyDetail
}

func (f *feat) add(name string)      { f.features = append(f.features, name) }
func (f *feat) kv(key, val string)   { if val != "" { f.details = append(f.details, PolicyDetail{Key: key, Value: val}) } }
func (f *feat) decode() PolicyDecode {
	if len(f.features) == 0 {
		return PolicyDecode{}
	}
	return PolicyDecode{Summary: strings.Join(f.features, " + "), Details: f.details}
}

// specMap returns spec as a map (nil-safe; "spec" may be absent or malformed).
func specMap(u *unstructured.Unstructured) map[string]interface{} {
	m, _, _ := unstructured.NestedMap(u.Object, "spec")
	return m
}

func decodeBTP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	if retry, ok := s["retry"].(map[string]interface{}); ok {
		f.add("retries")
		if n, ok, _ := unstructured.NestedInt64(retry, "numRetries"); ok {
			f.kv("retries", strconv.FormatInt(n, 10))
		}
		if t, _, _ := unstructured.NestedString(retry, "perRetry", "timeout"); t != "" {
			f.kv("per try timeout", t)
		}
	}
	if timeout, ok := s["timeout"].(map[string]interface{}); ok {
		f.add("timeout")
		if t, _, _ := unstructured.NestedString(timeout, "http", "requestTimeout"); t != "" {
			f.kv("request timeout", t)
		}
	}
	if lb, ok := s["loadBalancer"].(map[string]interface{}); ok {
		f.add("load balancer")
		if t, _ := lb["type"].(string); t != "" {
			f.kv("load balancer", t)
		}
	}
	if _, ok := s["circuitBreaker"]; ok {
		f.add("circuit breaker")
	}
	if _, ok := s["rateLimit"]; ok {
		f.add("rate limit")
	}
	return f.decode()
}

func decodeCTP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	if h2, ok := s["http2"].(map[string]interface{}); ok {
		f.add("http2")
		if w, _ := h2["initialStreamWindowSize"].(string); w != "" {
			f.kv("HTTP/2 stream window", w)
		}
	}
	if conn, ok := s["connection"].(map[string]interface{}); ok {
		f.add("connection-limit")
		if v, ok, _ := unstructured.NestedInt64(conn, "connectionLimit", "value"); ok {
			f.kv("max connections", strconv.FormatInt(v, 10))
		}
	}
	if _, ok := s["tls"]; ok {
		f.add("tls")
	}
	if _, ok := s["timeout"]; ok {
		f.add("timeout")
	}
	if _, ok := s["tcpKeepalive"]; ok {
		f.add("keepalive")
	}
	return f.decode()
}

func decodeSP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	// Presence-only: auth intent is ambiguous to decode safely.
	for _, p := range []struct{ key, label string }{
		{"jwt", "jwt"}, {"oidc", "oidc"}, {"extAuth", "ext-auth"},
		{"basicAuth", "basic-auth"}, {"apiKeyAuth", "api-key"},
		{"cors", "cors"}, {"authorization", "authorization"},
	} {
		if _, ok := s[p.key]; ok {
			f.add(p.label)
		}
	}
	return f.decode()
}

func decodeEEP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	for _, p := range []struct{ key, label string }{
		{"extProc", "ext-proc"}, {"wasm", "wasm"}, {"lua", "lua"},
	} {
		if sl, ok, _ := unstructured.NestedSlice(u.Object, "spec", p.key); ok && len(sl) > 0 {
			f.add(p.label)
		}
	}
	return f.decode()
}

func decodeBTLS(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	val, ok, _ := unstructured.NestedMap(u.Object, "spec", "validation")
	if !ok || val == nil {
		return PolicyDecode{}
	}
	if h, _ := val["hostname"].(string); h != "" {
		f.add("hostname")
		f.kv("hostname", h)
	}
	if _, ok := val["wellKnownCACertificates"]; ok {
		f.add("well-known-ca")
	}
	if ca, ok, _ := unstructured.NestedSlice(val, "caCertificateRefs"); ok && len(ca) > 0 {
		f.add("ca")
	}
	return f.decode()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gwapi/ -run TestDecode -v` then `go vet ./internal/gwapi/`
Expected: PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/gwapi/policy_decode.go internal/gwapi/policy_decode_test.go
git commit -m "feat(gwapi): per-kind policy decoder registry (value-free summaries)"
```

---

## Task 3: `BuildPolicyRefs` (fan-out + ns default) + `AttachPolicies`

**Files:**
- Modify: `internal/gwapi/policy.go`
- Modify: `internal/gwapi/policy_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/gwapi/policy_test.go`:

```go
func TestBuildPolicyRefsFanOutAndNamespaceDefault(t *testing.T) {
	// One BTP targeting two routes; first target omits namespace (defaults to the
	// policy's "apps"), second sets it explicitly.
	u := polObj("BackendTrafficPolicy", "apps", "btp", []interface{}{
		tref("HTTPRoute", "r1", "", ""),
		tref("HTTPRoute", "r2", "other", ""),
	}, nil, map[string]interface{}{"retry": map[string]interface{}{"numRetries": int64(2)}})

	refs := BuildPolicyRefs(u, "BackendTrafficPolicy")
	if len(refs) != 2 {
		t.Fatalf("fan-out: %+v", refs)
	}
	if refs[0].TargetNamespace != "apps" {
		t.Fatalf("target ns default: %+v", refs[0])
	}
	if refs[1].TargetNamespace != "other" {
		t.Fatalf("explicit target ns: %+v", refs[1])
	}
	// Decoded summary/details shared across fan-out.
	if refs[0].Summary != "retries" || refs[0].Name != "btp" || refs[0].Namespace != "apps" {
		t.Fatalf("ref[0]: %+v", refs[0])
	}
}

func TestAttachPoliciesPlacesByTarget(t *testing.T) {
	topo := &Topology{
		Gateway: GatewayNode{Namespace: "infra", Name: "eg"},
		Routes: []RouteNode{{
			Namespace: "apps", Name: "share",
			Services: []ServiceNode{{Namespace: "apps", Name: "share-api"}},
		}},
	}
	refs := []PolicyRef{
		{Kind: "ClientTrafficPolicy", Name: "ctp", TargetKind: "Gateway", TargetNamespace: "infra", TargetName: "eg"},
		{Kind: "BackendTrafficPolicy", Name: "btp", TargetKind: "HTTPRoute", TargetNamespace: "apps", TargetName: "share"},
		{Kind: "BackendTLSPolicy", Name: "btls", TargetKind: "Service", TargetNamespace: "apps", TargetName: "share-api"},
		{Kind: "SecurityPolicy", Name: "ghost", TargetKind: "HTTPRoute", TargetNamespace: "apps", TargetName: "nope"},
	}
	AttachPolicies(topo, refs)

	if len(topo.Gateway.Policies) != 1 || topo.Gateway.Policies[0].Name != "ctp" {
		t.Fatalf("gateway: %+v", topo.Gateway.Policies)
	}
	if len(topo.Routes[0].Policies) != 1 || topo.Routes[0].Policies[0].Name != "btp" {
		t.Fatalf("route: %+v", topo.Routes[0].Policies)
	}
	if len(topo.Routes[0].Services[0].Policies) != 1 || topo.Routes[0].Services[0].Policies[0].Name != "btls" {
		t.Fatalf("service: %+v", topo.Routes[0].Services[0].Policies)
	}
	// The non-matching SecurityPolicy is dropped silently (belongs elsewhere).
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run 'TestBuildPolicyRefs|TestAttachPolicies' -v`
Expected: FAIL — `BuildPolicyRefs` / `AttachPolicies` undefined.

- [ ] **Step 3: Append to `internal/gwapi/policy.go`**

```go
// BuildPolicyRefs fans a policy into one PolicyRef per targetRef, sharing the
// decoded summary/details. targetRef namespace defaults to the policy's namespace
// when omitted.
func BuildPolicyRefs(u *unstructured.Unstructured, kind string) []PolicyRef {
	dec := Decode(kind, u)
	polNS := u.GetNamespace()
	var out []PolicyRef
	for _, t := range PolicyTargets(u) {
		tns := t.Namespace
		if tns == "" {
			tns = polNS
		}
		out = append(out, PolicyRef{
			Kind: kind, Namespace: polNS, Name: u.GetName(),
			TargetKind: t.Kind, TargetNamespace: tns, TargetName: t.Name, TargetSectionName: t.SectionName,
			Summary: dec.Summary, Details: dec.Details,
		})
	}
	return out
}

// AttachPolicies places each PolicyRef on the node its resolved target names.
// A ref whose target matches nothing in this (single-Gateway) topology is dropped.
func AttachPolicies(topo *Topology, refs []PolicyRef) {
	for _, p := range refs {
		switch p.TargetKind {
		case "Gateway":
			if p.TargetNamespace == topo.Gateway.Namespace && p.TargetName == topo.Gateway.Name {
				topo.Gateway.Policies = append(topo.Gateway.Policies, p)
			}
		case "HTTPRoute":
			for i := range topo.Routes {
				if topo.Routes[i].Namespace == p.TargetNamespace && topo.Routes[i].Name == p.TargetName {
					topo.Routes[i].Policies = append(topo.Routes[i].Policies, p)
				}
			}
		case "Service":
			for i := range topo.Routes {
				for j := range topo.Routes[i].Services {
					s := &topo.Routes[i].Services[j]
					if s.Namespace == p.TargetNamespace && s.Name == p.TargetName {
						s.Policies = append(s.Policies, p)
					}
				}
			}
		}
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gwapi/ -v` then `go vet ./internal/gwapi/`
Expected: PASS (all gwapi tests), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/gwapi/policy.go internal/gwapi/policy_test.go
git commit -m "feat(gwapi): BuildPolicyRefs (fan-out + ns default) + AttachPolicies"
```

---

## Task 4: fleet policy pass (five GVRs, two warning classes)

**Files:**
- Modify: `internal/fleet/gateway.go`
- Create: `internal/fleet/gateway_policy_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/gateway_policy_test.go`:

```go
package fleet

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/clock"
)

func ctpGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "clienttrafficpolicies"}
}
func btpGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "backendtrafficpolicies"}
}
func btlsGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1alpha3", Resource: "backendtlspolicies"}
}

func policy(apiVersion, kind, ns, name string, targetRef map[string]interface{}, spec map[string]interface{}) *unstructured.Unstructured {
	s := map[string]interface{}{"targetRef": targetRef}
	for k, v := range spec {
		s[k] = v
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": apiVersion, "kind": kind,
		"metadata": map[string]interface{}{"namespace": ns, "name": name},
		"spec":     s,
	}}
}

// policyDiscovery advertises the served policy resources for fake discovery.
func policyDiscovery() []*metav1.APIResourceList {
	return []*metav1.APIResourceList{
		{GroupVersion: "gateway.envoyproxy.io/v1alpha1", APIResources: []metav1.APIResource{
			{Name: "clienttrafficpolicies", Namespaced: true, Kind: "ClientTrafficPolicy"},
			{Name: "backendtrafficpolicies", Namespaced: true, Kind: "BackendTrafficPolicy"},
			{Name: "securitypolicies", Namespaced: true, Kind: "SecurityPolicy"},
			{Name: "envoyextensionpolicies", Namespaced: true, Kind: "EnvoyExtensionPolicy"},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1alpha3", APIResources: []metav1.APIResource{
			{Name: "backendtlspolicies", Namespaced: true, Kind: "BackendTLSPolicy"},
		}},
	}
}

func TestGatewayTopologyAttachesEnvoyPolicies(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{
		gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList",
		ctpGVR(): "ClientTrafficPolicyList", btpGVR(): "BackendTrafficPolicyList", btlsGVR(): "BackendTLSPolicyList",
		{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "securitypolicies"}:    "SecurityPolicyList",
		{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "envoyextensionpolicies"}: "EnvoyExtensionPolicyList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds)
	seed := func(gvr schema.GroupVersionResource, o *unstructured.Unstructured) {
		ns, _, _ := unstructured.NestedString(o.Object, "metadata", "namespace")
		if _, err := dyn.Resource(gvr).Namespace(ns).Create(context.Background(), o, metav1.CreateOptions{}); err != nil {
			t.Fatalf("seed %s: %v", gvr, err)
		}
	}
	seed(gwGVR(), gw("eg", "infra"))
	seed(hrGVR(), hr("share", "apps", "eg", "infra", "share-api"))
	// CTP -> gateway; BTP -> route; BackendTLSPolicy -> the backend Service.
	seed(ctpGVR(), policy("gateway.envoyproxy.io/v1alpha1", "ClientTrafficPolicy", "infra", "ctp",
		map[string]interface{}{"kind": "Gateway", "name": "eg"},
		map[string]interface{}{"http2": map[string]interface{}{}}))
	seed(btpGVR(), policy("gateway.envoyproxy.io/v1alpha1", "BackendTrafficPolicy", "apps", "btp",
		map[string]interface{}{"kind": "HTTPRoute", "name": "share"},
		map[string]interface{}{"retry": map[string]interface{}{"numRetries": int64(3)}}))
	seed(btlsGVR(), policy("gateway.networking.k8s.io/v1alpha3", "BackendTLSPolicy", "apps", "btls",
		map[string]interface{}{"kind": "Service", "name": "share-api"},
		map[string]interface{}{"validation": map[string]interface{}{"hostname": "share-api.apps"}}))

	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Ports: []corev1.ServicePort{{Port: 80}}}}
	typed := typedfake.NewSimpleClientset(svc)
	typed.Resources = policyDiscovery()

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	if len(topo.Gateway.Policies) != 1 || topo.Gateway.Policies[0].Kind != "ClientTrafficPolicy" {
		t.Fatalf("gateway policies: %+v", topo.Gateway.Policies)
	}
	if len(topo.Routes) != 1 || len(topo.Routes[0].Policies) != 1 || topo.Routes[0].Policies[0].Summary != "retries" {
		t.Fatalf("route policies: %+v", topo.Routes)
	}
	if len(topo.Routes[0].Services[0].Policies) != 1 || topo.Routes[0].Services[0].Policies[0].Kind != "BackendTLSPolicy" {
		t.Fatalf("service policies: %+v", topo.Routes[0].Services[0].Policies)
	}
}

func TestGatewayTopologyPolicyWarnings(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{
		gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList", btpGVR(): "BackendTrafficPolicyList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds)
	ns := func(o *unstructured.Unstructured) string { s, _, _ := unstructured.NestedString(o.Object, "metadata", "namespace"); return s }
	for gvr, o := range map[schema.GroupVersionResource]*unstructured.Unstructured{
		gwGVR(): gw("eg", "infra"),
		hrGVR(): hr("share", "apps", "eg", "infra", "share-api"),
	} {
		if _, err := dyn.Resource(gvr).Namespace(ns(o)).Create(context.Background(), o, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	// BackendTrafficPolicy list fails (served but forbidden).
	dyn.PrependReactor("list", "backendtrafficpolicies", func(clienttesting.Action) (bool, interface{}, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "gateway.envoyproxy.io", Resource: "backendtrafficpolicies"}, "", nil)
	})

	typed := typedfake.NewSimpleClientset(&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"}})
	// Only BackendTrafficPolicy is served; the others are "not installed".
	typed.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.envoyproxy.io/v1alpha1", APIResources: []metav1.APIResource{
			{Name: "backendtrafficpolicies", Namespaced: true, Kind: "BackendTrafficPolicy"},
		}},
	}

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	var hasNotInstalled, hasForbidden bool
	for _, w := range topo.Warnings {
		if strings.Contains(w, "CRD not installed") {
			hasNotInstalled = true
		}
		if strings.Contains(w, "could not list BackendTrafficPolicy") && strings.Contains(w, "forbidden") {
			hasForbidden = true
		}
	}
	if !hasNotInstalled {
		t.Fatalf("want an informational 'CRD not installed' warning: %+v", topo.Warnings)
	}
	if !hasForbidden {
		t.Fatalf("want an operational 'could not list ... forbidden' warning: %+v", topo.Warnings)
	}
}
```

NOTE: reuse the existing `dynScheme()`, `gw()`, `hr()`, `gwGVR()`, `hrGVR()` from `internal/fleet/gateway_test.go`.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run 'TestGatewayTopologyAttaches|TestGatewayTopologyPolicy' -v`
Expected: FAIL — gateway policies stay empty (no policy pass yet).

- [ ] **Step 3: Add the policy pass to `internal/fleet/gateway.go`**

Add the import for `schema` is already present. Add these declarations and method, and call it from `GetGatewayTopology`:

```go
const envoyGroup = "gateway.envoyproxy.io"

// policyKinds is the M5-b-i precise policy set (display Kind + resource + group).
var policyKinds = []struct{ Kind, Group, Resource string }{
	{"ClientTrafficPolicy", envoyGroup, "clienttrafficpolicies"},
	{"BackendTrafficPolicy", envoyGroup, "backendtrafficpolicies"},
	{"SecurityPolicy", envoyGroup, "securitypolicies"},
	{"EnvoyExtensionPolicy", envoyGroup, "envoyextensionpolicies"},
	{"BackendTLSPolicy", gwGroup, "backendtlspolicies"},
}

// policyCandidateVersions lists the versions a policy resource may be served at,
// preferred first. A resource's version is resolved per-resource (not via the
// group's preferred version, since BackendTLSPolicy lives at v1alpha3 while the
// gateway.networking.k8s.io group prefers v1).
var policyCandidateVersions = map[string][]string{
	envoyGroup: {"v1alpha1"},
	gwGroup:    {"v1", "v1alpha3", "v1alpha2"},
}

// servedResourceGVR finds the served GVR for a (group, resource), probing the
// candidate versions in order. ok=false means the CRD is not installed.
func (c *ClusterConn) servedResourceGVR(group, resource string) (schema.GroupVersionResource, bool) {
	disc := c.typed.Discovery()
	for _, v := range policyCandidateVersions[group] {
		rl, err := disc.ServerResourcesForGroupVersion(group + "/" + v)
		if err != nil || rl == nil {
			continue
		}
		for _, r := range rl.APIResources {
			if r.Name == resource {
				return schema.GroupVersionResource{Group: group, Version: v, Resource: resource}, true
			}
		}
	}
	return schema.GroupVersionResource{}, false
}

// attachGatewayPolicies lists the five precise policy kinds and attaches them by
// targetRef. Two warning classes: not-installed (informational) and served-but-
// list-failed (operational).
func (c *ClusterConn) attachGatewayPolicies(ctx context.Context, topo *gwapi.Topology) {
	for _, pk := range policyKinds {
		gvr, ok := c.servedResourceGVR(pk.Group, pk.Resource)
		if !ok {
			topo.Warnings = append(topo.Warnings, pk.Kind+" CRD not installed")
			continue
		}
		list, err := c.dyn.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err != nil {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("could not list %s: %v", pk.Kind, err))
			continue
		}
		var refs []gwapi.PolicyRef
		for i := range list.Items {
			u := &unstructured.Unstructured{Object: list.Items[i].Object}
			refs = append(refs, gwapi.BuildPolicyRefs(u, pk.Kind)...)
		}
		gwapi.AttachPolicies(topo, refs)
	}
}
```

In `GetGatewayTopology`, insert the policy pass right before `return topo, nil` (after the route loop):

```go
	c.attachGatewayPolicies(ctx, &topo)
	return topo, nil
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestGatewayTopology' -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`
Expected: PASS (incl. the pre-existing M5-a topology tests — the policy pass adds "CRD not installed" warnings there, which those tests don't assert on, so they still pass), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/gateway.go internal/fleet/gateway_policy_test.go
git commit -m "feat(fleet): attach Envoy/Gateway-API policies by targetRef (two warning classes)"
```

---

## Task 5: appbridge DTO (policy details + service policies)

**Files:**
- Modify: `internal/appbridge/gateway_dto.go`
- Modify: `internal/appbridge/gateway_service_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/appbridge/gateway_service_test.go` (a new test function):

```go
func TestGatewayTopologyDTOPolicies(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway: gwapi.GatewayNode{Namespace: "infra", Name: "eg", Policies: []gwapi.PolicyRef{
			{Kind: "ClientTrafficPolicy", Namespace: "infra", Name: "ctp", TargetKind: "Gateway", TargetNamespace: "infra", TargetName: "eg", Summary: "http2"},
		}},
		Routes: []gwapi.RouteNode{{
			Namespace: "apps", Name: "share",
			Policies: []gwapi.PolicyRef{{Kind: "BackendTrafficPolicy", Namespace: "apps", Name: "btp", TargetKind: "HTTPRoute", TargetName: "share", Summary: "retries + timeout", Details: []gwapi.PolicyDetail{{Key: "retries", Value: "3"}, {Key: "request timeout", Value: "30s"}}}},
			Services: []gwapi.ServiceNode{{Namespace: "apps", Name: "share-api", Resolved: true, Policies: []gwapi.PolicyRef{{Kind: "BackendTLSPolicy", Name: "btls", TargetKind: "Service", TargetName: "share-api", Summary: "hostname"}}}},
		}},
	}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")

	if len(d.Gateway.Policies) != 1 || d.Gateway.Policies[0].Kind != "ClientTrafficPolicy" || d.Gateway.Policies[0].TargetName != "eg" {
		t.Fatalf("gateway policy DTO: %+v", d.Gateway.Policies)
	}
	rp := d.Routes[0].Policies
	if len(rp) != 1 || rp[0].Summary != "retries + timeout" || len(rp[0].Details) != 2 || rp[0].Details[0].Key != "retries" || rp[0].Details[0].Value != "3" {
		t.Fatalf("route policy DTO: %+v", rp)
	}
	sp := d.Routes[0].Services[0].Policies
	if len(sp) != 1 || sp[0].Kind != "BackendTLSPolicy" {
		t.Fatalf("service policy DTO: %+v", sp)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGatewayTopologyDTOPolicies -v`
Expected: FAIL — `PolicyRefDTO` has no `Details`/`TargetName`; `ServiceNodeDTO` has no `Policies`.

- [ ] **Step 3: Modify `internal/appbridge/gateway_dto.go`**

Add `PolicyDetailDTO` and replace `PolicyRefDTO`:

```go
type PolicyDetailDTO struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}
type PolicyRefDTO struct {
	Kind              string            `json:"kind"`
	Namespace         string            `json:"namespace"`
	Name              string            `json:"name"`
	TargetKind        string            `json:"targetKind"`
	TargetNamespace   string            `json:"targetNamespace"`
	TargetName        string            `json:"targetName"`
	TargetSectionName string            `json:"targetSectionName"`
	Summary           string            `json:"summary"`
	Details           []PolicyDetailDTO `json:"details"`
	Inferred          bool              `json:"inferred"`
}
```

Add `Policies` to `ServiceNodeDTO`:

```go
type ServiceNodeDTO struct {
	Namespace string         `json:"namespace"`
	Name      string         `json:"name"`
	Type      string         `json:"type"`
	Port      int32          `json:"port"`
	Resolved  bool           `json:"resolved"`
	Policies  []PolicyRefDTO `json:"policies"`
	CNPs      []PolicyRefDTO `json:"cnps"`
}
```

Replace `policyDTOs` to map the new fields:

```go
func policyDTOs(ps []gwapi.PolicyRef) []PolicyRefDTO {
	out := make([]PolicyRefDTO, 0, len(ps))
	for _, p := range ps {
		details := make([]PolicyDetailDTO, 0, len(p.Details))
		for _, d := range p.Details {
			details = append(details, PolicyDetailDTO{Key: d.Key, Value: d.Value})
		}
		out = append(out, PolicyRefDTO{
			Kind: p.Kind, Namespace: p.Namespace, Name: p.Name,
			TargetKind: p.TargetKind, TargetNamespace: p.TargetNamespace, TargetName: p.TargetName, TargetSectionName: p.TargetSectionName,
			Summary: p.Summary, Details: details, Inferred: p.Inferred,
		})
	}
	return out
}
```

In `toTopologyDTO`, add `Policies` to the `ServiceNodeDTO` construction (the `for _, s := range r.Services` loop):

```go
		for _, s := range r.Services {
			rd.Services = append(rd.Services, ServiceNodeDTO{Namespace: s.Namespace, Name: s.Name, Type: s.Type, Port: s.Port, Resolved: s.Resolved, Policies: policyDTOs(s.Policies), CNPs: policyDTOs(s.CNPs)})
		}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/appbridge/ -v` then `go vet ./internal/appbridge/`
Expected: PASS (the existing DTO tests still pass — `policyDTOs` is additive), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/appbridge/gateway_dto.go internal/appbridge/gateway_service_test.go
git commit -m "feat(appbridge): policy DTO target metadata + decoded details + service policies"
```

---

## Task 6: frontend store types + `PolicyChip` on the three nodes

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Create: `cmd/klyx/frontend/src/cluster/PolicyChip.tsx`, `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`, `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

- [ ] **Step 1: Update store types in `cmd/klyx/frontend/src/store/fleet.ts`**

Replace the `PolicyRefDTO` line (currently `export type PolicyRefDTO = { kind: string; name: string; summary: string; inferred: boolean };`) and add `PolicyDetailDTO`:

```ts
export type PolicyDetailDTO = { key: string; value: string };
export type PolicyRefDTO = { kind: string; namespace: string; name: string; targetKind: string; targetNamespace: string; targetName: string; targetSectionName: string; summary: string; details: PolicyDetailDTO[]; inferred: boolean };
```

Replace the `ServiceNodeDTO` line to add `policies`:

```ts
export type ServiceNodeDTO = { namespace: string; name: string; type: string; port: number; resolved: boolean; policies: PolicyRefDTO[]; cnps: PolicyRefDTO[] };
```

- [ ] **Step 1b: Update existing service fixtures so they carry `policies`**

Adding `policies` to `ServiceNodeDTO` means every existing `ServiceNodeDTO` literal needs it, and the new render code reads `svc.policies.length` (which throws if `policies` is `undefined` — vitest strips types, so this is a runtime crash, not a compile error). Update the two service-building spots in `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`:

In the shared `topo` fixture's `services`, add `policies: []`:

```tsx
    services: [{ namespace: "apps", name: "share-api", type: "ClusterIP", port: 8080, resolved: true, policies: [], cnps: [] }],
```

In the `route()` helper, add `policies: []` to the service object:

```tsx
    services: [{ namespace, name: svc, type: "ClusterIP", port: 80, resolved: true, policies: [], cnps: [] }],
```

Run `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx` — still all green (no behaviour change yet; this just keeps the fixtures valid for the upcoming render change).

- [ ] **Step 2: Write the failing `PolicyChip` test**

Create `cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PolicyChip } from "./PolicyChip";
import type { PolicyRefDTO } from "../store/fleet";

const btp: PolicyRefDTO = {
  kind: "BackendTrafficPolicy", namespace: "apps", name: "btp",
  targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "",
  summary: "retries + timeout",
  details: [{ key: "retries", value: "3" }, { key: "request timeout", value: "30s" }],
  inferred: false,
};

describe("PolicyChip", () => {
  it("renders the kind abbreviation + value-free summary", () => {
    const { getByText } = render(<PolicyChip p={btp} />);
    expect(getByText(/BTP/)).toBeTruthy();
    expect(getByText(/retries \+ timeout/)).toBeTruthy();
  });

  it("exposes the first detail rows as a tooltip title", () => {
    const { getByTitle } = render(<PolicyChip p={btp} />);
    expect(getByTitle(/retries: 3/)).toBeTruthy();
    expect(getByTitle(/request timeout: 30s/)).toBeTruthy();
  });

  it("falls back to kind/namespace/name when there are no details", () => {
    const { getByTitle } = render(<PolicyChip p={{ ...btp, details: [] }} />);
    expect(getByTitle(/BackendTrafficPolicy\/apps\/btp/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/PolicyChip.test.tsx`
Expected: FAIL — cannot find module `./PolicyChip`.

- [ ] **Step 4: Implement `cmd/klyx/frontend/src/cluster/PolicyChip.tsx`**

```tsx
import type { PolicyRefDTO } from "../store/fleet";

const ABBREV: Record<string, string> = {
  ClientTrafficPolicy: "CTP",
  BackendTrafficPolicy: "BTP",
  SecurityPolicy: "SP",
  EnvoyExtensionPolicy: "EEP",
  BackendTLSPolicy: "BTLS",
  CiliumNetworkPolicy: "CNP",
  CiliumClusterwideNetworkPolicy: "CCNP",
};

const COLOUR: Record<string, { fg: string; bg: string }> = {
  ClientTrafficPolicy: { fg: "#58a6ff", bg: "rgba(56,139,253,.16)" },
  BackendTrafficPolicy: { fg: "#a371f7", bg: "rgba(163,113,247,.16)" },
  SecurityPolicy: { fg: "#3fb950", bg: "rgba(46,160,67,.16)" },
  EnvoyExtensionPolicy: { fg: "#d29922", bg: "rgba(210,153,34,.16)" },
  BackendTLSPolicy: { fg: "#ec6547", bg: "rgba(236,101,71,.16)" },
};

export function policyTooltip(p: PolicyRefDTO): string {
  if (p.details.length === 0) return `${p.kind}/${p.namespace}/${p.name}`;
  return p.details.slice(0, 4).map((d) => `${d.key}: ${d.value}`).join("\n");
}

export function PolicyChip({ p }: { p: PolicyRefDTO }) {
  const abbr = ABBREV[p.kind] ?? p.kind;
  const c = COLOUR[p.kind] ?? { fg: "var(--color-text-secondary)", bg: "var(--color-background-secondary)" };
  return (
    <span
      title={policyTooltip(p)}
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
        cursor: "default",
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <b style={{ fontWeight: 700 }}>{abbr}</b>
      {p.summary && <span>{p.summary}</span>}
      {p.inferred && <span style={{ opacity: 0.7 }}>~</span>}
    </span>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/PolicyChip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing topology chip test**

Add to `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` (inside the existing `describe`). The shared `topo` fixture has empty `policies`/`services[].policies`; this test seeds a topology with policies on all three nodes:

```tsx
  it("renders policy chips on the gateway header, route, and service", () => {
    const withPolicies: TopologyDTO = {
      gateway: { ...topo.gateway, policies: [{ kind: "ClientTrafficPolicy", namespace: "infra", name: "ctp", targetKind: "Gateway", targetNamespace: "infra", targetName: "eg", targetSectionName: "", summary: "http2", details: [], inferred: false }] },
      routes: [{
        ...topo.routes[0],
        policies: [{ kind: "BackendTrafficPolicy", namespace: "apps", name: "btp", targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "", summary: "retries", details: [{ key: "retries", value: "3" }], inferred: false }],
        services: [{ ...topo.routes[0].services[0], policies: [{ kind: "BackendTLSPolicy", namespace: "apps", name: "btls", targetKind: "Service", targetNamespace: "apps", targetName: "share-api", targetSectionName: "", summary: "hostname", details: [], inferred: false }] }],
      }],
      warnings: [],
    };
    seed(withPolicies);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/CTP/)).toBeTruthy();   // gateway header
    expect(getByText(/BTP/)).toBeTruthy();   // route box
    expect(getByText(/BTLS/)).toBeTruthy();  // service box
  });
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx -t "policy chips"`
Expected: FAIL — chips not rendered.

- [ ] **Step 8: Render chips in `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`**

Add the import at the top:

```tsx
import { PolicyChip } from "./PolicyChip";
```

In the **header** block (the `<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>` that shows the gateway name/status/class), add the gateway policy chips after the className span, before the `flex:1` spacer:

```tsx
        {t.gateway.policies.map((p) => (
          <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
        ))}
```

In the **httproute box** (the clickable `<div>` with `onClick={() => selectRoute(routeKey(r))}`), add a chip row after the status line `<div style={{ fontSize: 9, marginTop: 2, ...ellipsis }}>…</div>`:

```tsx
                  {r.policies.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {r.policies.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
```

In the **service box** (the `<div style={nb}>` containing the `service` label), add after the `type :port` sub-line:

```tsx
                  {svc && svc.policies.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {svc.policies.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
```

- [ ] **Step 9: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx src/cluster/PolicyChip.test.tsx`
Expected: PASS (all topology + chip tests).

- [ ] **Step 10: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/cluster/PolicyChip.tsx cmd/klyx/frontend/src/cluster/PolicyChip.test.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): policy chips on gateway header, route, and service nodes"
```

---

## Task 7: route detail "attached policies" section

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` (inside the existing `describe`):

```tsx
  it("shows attached policies (with target + detail rows) in the route detail panel", () => {
    const withPolicies: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{
        ...topo.routes[0],
        policies: [{ kind: "BackendTrafficPolicy", namespace: "apps", name: "backend-retries", targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "", summary: "retries + timeout", details: [{ key: "retries", value: "3" }, { key: "request timeout", value: "30s" }], inferred: false }],
        services: [topo.routes[0].services[0]],
      }],
      warnings: [],
    };
    seed(withPolicies);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share")); // open the detail panel
    expect(getByText(/attached policies/i)).toBeTruthy();
    expect(getByText("backend-retries")).toBeTruthy();
    expect(getByText(/Target: HTTPRoute\/share/)).toBeTruthy();
    expect(getByText(/request timeout/)).toBeTruthy();
    expect(getByText(/Gateway policies are shown in the topology header/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx -t "attached policies"`
Expected: FAIL — no such section.

- [ ] **Step 3: Add the section to the `RouteDetail` component in `NetworkTopology.tsx`**

`RouteDetail` currently renders a 2-column matches/backends grid. After that grid `</div>` (still inside the outer `RouteDetail` `<div>`), add the attached-policies section. The route's service policies are passed in alongside the route. Change the `RouteDetail` call site and signature to also receive the route's services:

At the call site `{selected && <RouteDetail route={selected} />}` — no change needed (selected is the full `RouteNodeDTO`, which already carries `services` with their `policies`).

Add to the end of `RouteDetail`, before its closing `</div>`:

```tsx
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>attached policies</div>
        {(() => {
          const svcPolicies = route.services.flatMap((s) => s.policies);
          const all = [...route.policies, ...svcPolicies];
          if (all.length === 0) {
            return <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>None on this route.</div>;
          }
          return all.map((p) => (
            <div key={`${p.kind}/${p.namespace}/${p.name}`} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ fontWeight: 600 }}>{p.kind}/{p.name}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
                Target: {p.targetKind}/{p.targetName}{p.targetSectionName ? ` (Section: ${p.targetSectionName})` : ""}
              </div>
              {p.summary && <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>Features: {p.summary}</div>}
              {p.details.map((d, i) => (
                <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-secondary)" }}>{d.key}: {d.value}</div>
              ))}
            </div>
          ));
        })()}
        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>Gateway policies are shown in the topology header.</div>
      </div>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx`
Expected: PASS (all topology tests, including the new section test).

- [ ] **Step 5: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): route detail 'attached policies' section + header hint"
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
Expected: vitest green; **tsc clean** (the new `PolicyDetailDTO`, `PolicyRefDTO` fields, and `ServiceNodeDTO.policies` compile against `PolicyChip.tsx` + `NetworkTopology.tsx`); build exit 0 (ignore `ld: warning` noise and the known `cmd/klyx/build/ios` scaffold artifact).

NOTE: `cmd/klyx/frontend/bindings/` is gitignored (a generated artifact) — there is nothing to commit from `wails3 generate bindings`; it only needs to exist so `tsc` resolves the `GatewayService` binding.

- [ ] **Step 3: Clean up build output**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
rm -f klyx cmd/klyx/bin/klyx 2>/dev/null; git status --short
```
Expected: clean tree (no stray binary staged).

- [ ] **Step 4: Native handoff (owner, homelab-nelli)**

On homelab-nelli's Envoy Gateway, open the cluster → Network → select the Envoy Gateway and confirm:
- Gateway-level policy chips (ClientTrafficPolicy, and any gateway-targeted BTP/SP/EEP) render once in the topology header.
- Route-targeted policies (BTP/SP/EEP) render on the httproute box; backend Services with a BackendTLSPolicy show a BTLS chip.
- Chip text is feature presence only (e.g. `BTP retries + timeout`), never a decoded value.
- Hovering a chip shows the first 2-4 decoded rows (e.g. `retries: 3`).
- Clicking a route opens the detail panel "attached policies" section: each policy's kind/name, `Target: Kind/name`, features, decoded rows, plus the "gateway policies are shown in the topology header" hint.
- A cluster missing a policy CRD shows an informational "<Kind> CRD not installed" warning; an RBAC-restricted list shows an operational "could not list <Kind>: …forbidden" warning.

There is no merge step in this plan — M5-b-i gates on this native verification, then `finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** §1 model (`PolicyRef` Target*/Details, `PolicyDetail`, `ServiceNode.Policies`) → Task 1/3/5. §2 `PolicyTargets` → Task 1; decoder registry + fallback ladder + value-free invariant + deterministic ordering → Task 2; `BuildPolicyRefs` (fan-out + ns default) + `AttachPolicies` → Task 3. §3 fleet five-GVR pass + per-resource version resolution + two warning classes → Task 4. §4 DTO (details + target + service policies) → Task 5. §5 chips on header/route/service + tooltip + detail panel + header hint → Task 6/7. §6 testing → each task's tests; native handoff → Task 8.
- **Truth hierarchy honoured:** the `feat` helper builds `Summary` from feature names only (Task 2), so a decoded value can never leak into a chip; values live in `Details`; the YAML link (M5-a) remains the law.
- **Two warning classes:** `servedResourceGVR` ok=false → "CRD not installed" (informational); list error → "could not list …" (operational) — distinct strings, tested in Task 4.
- **BackendTLSPolicy visibility caveat:** `AttachPolicies` only lands a Service-targeted policy on a `ServiceNode` the topology renders (the primary backend); a non-primary target is dropped. Consistent with M5-a's primary-backend collapse; no false claim.
- **Inferred stays false:** every `PolicyRef` built here has `Inferred=false`; `ServiceNode.CNPs` is untouched (M5-b-ii).
- **Type consistency:** Go `PolicyRef{Kind,Namespace,Name,TargetKind,TargetNamespace,TargetName,TargetSectionName,Summary,Details,Inferred}` ↔ DTO `PolicyRefDTO` (same json camelCase) ↔ TS `PolicyRefDTO`; `PolicyDetail{Key,Value}` ↔ `PolicyDetailDTO{key,value}`; `ServiceNode.Policies` ↔ `ServiceNodeDTO.policies` ↔ TS `policies`. `AttachPolicies`/`BuildPolicyRefs`/`PolicyTargets`/`Decode` exported and identically named across tasks.
- **Additive safety:** Task 1's model change keeps the original four `PolicyRef` fields, so appbridge compiles between tasks; Task 5 swaps `policyDTOs` to the full mapping in the same commit as the DTO fields.
