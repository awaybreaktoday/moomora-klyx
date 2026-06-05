# M5-a: Gateway Topology — Structural Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the per-Gateway data path — Gateway → HTTPRoute → Service → Pods, with status and honest warnings — as deterministic columnar lanes in the cluster's Network section. NO policy attachment yet (that's M5-b).

**Architecture:** A new pure `internal/gwapi` package parses Gateways/HTTPRoutes (unstructured) and resolves route→gateway attachment with per-Gateway-scoped status; `ClusterConn` adds `ListGateways` (+ a served flag) and `GetGatewayTopology` (dynamic Gateway/HTTPRoute reads + typed Service/EndpointSlice reads, accumulating warnings); a bound `GatewayService` returns a `TopologyDTO` with `warnings`/`error` (never a silent zero-state); a React `NetworkTopology` lays out the columns. Snapshot, no watch.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic + typed fakes), Wails v3 bound services, React 19 + TS 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **Gateway API GVRs** (version resolved via the existing `preferredVersion(disc, group, fallback)` in `internal/fleet/gitopswatch.go`):
  - `gateway.networking.k8s.io`: `gateways`, `httproutes` (fallback `v1`).
- **Pod counts** come from EndpointSlices (the modern source): `c.typed.DiscoveryV1().EndpointSlices(ns).List(ctx, {LabelSelector: "kubernetes.io/service-name=<svc>"})`. Each `Endpoint` has `Conditions.Ready *bool`; ready = count where `*Ready`, total = len.
- **Served check** (for "Gateway API not installed" vs "no Gateways"): `c.typed.Discovery().ServerGroups()` → is `gateway.networking.k8s.io` in the group list. Mirrors `internal/capability/detector.go:servedGroups`.
- **Per-Gateway-scoped status (spec decision #14):** an HTTPRoute can attach to several Gateways; `status.parents[]` has one entry per parentRef. `Accepted`/`ResolvedRefs` for the lane must come from the parent entry matching THIS Gateway, not a global OR.
- **No policies in M5-a:** the `gwapi` model includes `Policies`/`PolicyRef` fields for forward-compatibility, but they stay empty here; M5-b fills them. `Warnings` IS in M5-a (unresolved backend / missing EndpointSlices are structural).
- **Clients on `ClusterConn`:** `dyn dynamic.Interface`, `typed kubernetes.Interface` (both already present).
- **Nav:** the `network` `ClusterSection` exists; `ClusterDetail.tsx` renders `<Placeholder>` for it. The route gains an optional `gateway` ref (sibling to `resource`/`instance`); `setSection`/`openResource`/etc. already rebuild fresh route literals so they drop it.
- **Capability:** `ClusterDTO.networkTier` (string) is already on the DTO + TS store. `NetworkView` renders when `networkTier !== "Absent"` and then distinguishes the three empty states via the `gatewayAPIServed` flag from `ListGateways`.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gwapi/model.go` | Topology/Gateway/Route/Service/etc. types | Create |
| `internal/gwapi/gateway.go` | `ParseGateway` | Create |
| `internal/gwapi/route.go` | `RouteForGateway` (parse + attach + scoped status) | Create |
| `internal/gwapi/*_test.go` | pure parsing/linking tests | Create |
| `internal/fleet/gateway.go` | `ClusterConn.ListGateways` + `GetGatewayTopology` | Create |
| `internal/fleet/gateway_test.go` | dynamic+typed fake tests | Create |
| `internal/fleet/conn.go` | `Conn` interface += 2 methods | Modify |
| `internal/fleet/registry_test.go` | `fakeConn` stubs | Modify |
| `internal/appbridge/gateway_dto.go` | DTOs + mapping | Create |
| `internal/appbridge/gateway_service.go` | `GatewayService` + `GatewayConn` | Create |
| `internal/appbridge/gateway_service_test.go` | mapping tests | Create |
| `cmd/klyx/main.go` | register `GatewayService` | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | route.gateway + network slice + types | Modify |
| `cmd/klyx/frontend/src/store/fleet.test.ts` | store action tests | Modify |
| `cmd/klyx/frontend/src/bridge/gateway.ts` | `listGateways` / `getGatewayTopology` | Create |
| `cmd/klyx/frontend/src/cluster/NetworkView.tsx` | Gateways list + 3 empty states | Create |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx` | columnar lanes + warnings banner | Create |
| `cmd/klyx/frontend/src/cluster/Network*.test.tsx` | view tests | Create |
| `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx` | render NetworkView for `network` | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` | gateway crumb + back | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx` | crumb test | Modify |

---

## Task 1: `internal/gwapi` model + `ParseGateway`

**Files:**
- Create: `internal/gwapi/model.go`, `internal/gwapi/gateway.go`, `internal/gwapi/gateway_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gwapi/gateway_test.go`:

```go
package gwapi

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func gwObj(name, ns, class string, listeners, conds []interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "Gateway",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"spec":       map[string]interface{}{"gatewayClassName": class, "listeners": listeners},
		"status":     map[string]interface{}{"conditions": conds},
	}}
}

func TestParseGateway(t *testing.T) {
	u := gwObj("eg-external", "envoy-gateway-system", "envoy-gateway",
		[]interface{}{
			map[string]interface{}{"name": "https", "protocol": "HTTPS", "port": int64(443), "hostname": "*.example.com"},
			map[string]interface{}{"name": "http", "protocol": "HTTP", "port": int64(80)},
		},
		[]interface{}{
			map[string]interface{}{"type": "Accepted", "status": "True"},
			map[string]interface{}{"type": "Programmed", "status": "True"},
		})
	g := ParseGateway(u)
	if g.Name != "eg-external" || g.Namespace != "envoy-gateway-system" || g.ClassName != "envoy-gateway" {
		t.Fatalf("ids: %+v", g)
	}
	if !g.Accepted || !g.Programmed {
		t.Fatalf("status: %+v", g)
	}
	if len(g.Listeners) != 2 || g.Listeners[0].Port != 443 || g.Listeners[0].Hostname != "*.example.com" || g.Listeners[1].Protocol != "HTTP" {
		t.Fatalf("listeners: %+v", g.Listeners)
	}
}

func TestParseGatewayNotProgrammed(t *testing.T) {
	u := gwObj("g", "n", "c", nil, []interface{}{
		map[string]interface{}{"type": "Accepted", "status": "True"},
		map[string]interface{}{"type": "Programmed", "status": "False"},
	})
	if g := ParseGateway(u); !g.Accepted || g.Programmed {
		t.Fatalf("want accepted, not programmed: %+v", g)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestParseGateway -v`
Expected: FAIL — package/`ParseGateway` undefined.

- [ ] **Step 3: Implement `internal/gwapi/model.go`**

```go
// Package gwapi parses Gateway API objects (read as unstructured) into a
// vocabulary-correct topology: Gateway -> HTTPRoute -> Service -> Pods, with
// per-Gateway-scoped route status. Pure: no client-go dependency beyond
// unstructured. Policy attachment is M5-b (the Policies fields stay empty here).
package gwapi

// Topology is the per-Gateway data path.
type Topology struct {
	Gateway  GatewayNode
	Routes   []RouteNode // one lane each
	Warnings []string    // soft, non-fatal issues (filled by the fleet layer)
}

type GatewayNode struct {
	Namespace, Name, ClassName string
	Listeners                  []Listener
	Accepted, Programmed       bool
	Policies                   []PolicyRef // M5-b; empty in M5-a
}

type RouteNode struct {
	Namespace, Name      string
	Hostnames            []string
	Matches              []Match
	Accepted, ResolvedRefs bool        // scoped to THIS Gateway's parentRef
	Backends             []Backend
	Policies             []PolicyRef    // M5-b; empty in M5-a
	Services             []ServiceNode  // resolved Service backends; lane shows primary
	Pods                 PodCount       // for the primary Service backend
}

type ServiceNode struct {
	Namespace, Name, Type string
	Port                  int32
	CNPs                  []PolicyRef // M5-b; empty in M5-a
	Resolved              bool        // false when the Service could not be read
}

type Listener struct {
	Name, Protocol, Hostname string
	Port                     int32
}
type Match struct{ PathType, PathValue, Method string }
type Backend struct {
	Kind, Name, Namespace string
	Port, Weight          int32
}
type PodCount struct {
	Ready, Total int
	Unknown      bool // EndpointSlices were unavailable
}
type PolicyRef struct {
	Kind, Name, Summary string
	Inferred            bool
}
type GatewayRef struct {
	Namespace, Name, ClassName string
	Accepted, Programmed       bool
}
```

- [ ] **Step 4: Implement `internal/gwapi/gateway.go`**

```go
package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// condTrue reports whether status.conditions has an entry of the given type with
// status "True".
func condTrue(obj map[string]interface{}, condType string) bool {
	conds, _, _ := unstructured.NestedSlice(obj, "status", "conditions")
	for _, c := range conds {
		m, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t == condType {
			s, _ := m["status"].(string)
			return s == "True"
		}
	}
	return false
}

// ParseGateway maps a Gateway unstructured to a GatewayNode (no routes).
func ParseGateway(u *unstructured.Unstructured) GatewayNode {
	g := GatewayNode{Namespace: u.GetNamespace(), Name: u.GetName()}
	g.ClassName, _, _ = unstructured.NestedString(u.Object, "spec", "gatewayClassName")
	g.Accepted = condTrue(u.Object, "Accepted")
	g.Programmed = condTrue(u.Object, "Programmed")
	ls, _, _ := unstructured.NestedSlice(u.Object, "spec", "listeners")
	for _, l := range ls {
		m, ok := l.(map[string]interface{})
		if !ok {
			continue
		}
		lis := Listener{}
		lis.Name, _ = m["name"].(string)
		lis.Protocol, _ = m["protocol"].(string)
		lis.Hostname, _ = m["hostname"].(string)
		if p, ok := m["port"].(int64); ok {
			lis.Port = int32(p)
		}
		g.Listeners = append(g.Listeners, lis)
	}
	return g
}

// ParseGatewayRef maps a Gateway to the lightweight list item.
func ParseGatewayRef(u *unstructured.Unstructured) GatewayRef {
	cls, _, _ := unstructured.NestedString(u.Object, "spec", "gatewayClassName")
	return GatewayRef{
		Namespace: u.GetNamespace(), Name: u.GetName(), ClassName: cls,
		Accepted: condTrue(u.Object, "Accepted"), Programmed: condTrue(u.Object, "Programmed"),
	}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/gwapi/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/gwapi/model.go internal/gwapi/gateway.go internal/gwapi/gateway_test.go
git commit -m "feat(gwapi): topology model + ParseGateway"
```

---

## Task 2: `gwapi.RouteForGateway` (parse + attach + scoped status)

**Files:**
- Create: `internal/gwapi/route.go`, `internal/gwapi/route_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gwapi/route_test.go`:

```go
package gwapi

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func hrObj(name, ns string, parentRefs, rules, statusParents, hostnames []interface{}) *unstructured.Unstructured {
	spec := map[string]interface{}{"parentRefs": parentRefs, "rules": rules}
	if hostnames != nil {
		spec["hostnames"] = hostnames
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"spec":       spec,
		"status":     map[string]interface{}{"parents": statusParents},
	}}
}

func parentRef(name, ns, section string) map[string]interface{} {
	m := map[string]interface{}{"name": name}
	if ns != "" {
		m["namespace"] = ns
	}
	if section != "" {
		m["sectionName"] = section
	}
	return m
}

func statusParent(name, ns string, accepted, resolved string) map[string]interface{} {
	pr := map[string]interface{}{"name": name}
	if ns != "" {
		pr["namespace"] = ns
	}
	return map[string]interface{}{
		"parentRef": pr,
		"conditions": []interface{}{
			map[string]interface{}{"type": "Accepted", "status": accepted},
			map[string]interface{}{"type": "ResolvedRefs", "status": resolved},
		},
	}
}

func rule(path, method, backend string, port, weight int64) map[string]interface{} {
	return map[string]interface{}{
		"matches": []interface{}{map[string]interface{}{
			"path":   map[string]interface{}{"type": "PathPrefix", "value": path},
			"method": method,
		}},
		"backendRefs": []interface{}{map[string]interface{}{
			"name": backend, "port": port, "weight": weight,
		}},
	}
}

func TestRouteForGatewayAttachesAndScopesStatus(t *testing.T) {
	// Route in ns "apps" attaches to Gateway "eg" in ns "infra" (cross-namespace),
	// accepted by THIS gateway but rejected by another parent.
	u := hrObj("share", "apps",
		[]interface{}{
			parentRef("eg", "infra", ""),
			parentRef("other-gw", "infra", ""),
		},
		[]interface{}{rule("/api/share", "GET", "share-api", 8080, 100)},
		[]interface{}{
			statusParent("eg", "infra", "True", "True"),
			statusParent("other-gw", "infra", "False", "True"), // rejected by the other
		},
		[]interface{}{"share.example.com"})

	rn, ok := RouteForGateway(u, "infra", "eg")
	if !ok {
		t.Fatal("route should attach to infra/eg")
	}
	if !rn.Accepted || !rn.ResolvedRefs {
		t.Fatalf("status must be scoped to infra/eg (accepted): %+v", rn)
	}
	if rn.Name != "share" || rn.Namespace != "apps" {
		t.Fatalf("ids: %+v", rn)
	}
	if len(rn.Hostnames) != 1 || rn.Hostnames[0] != "share.example.com" {
		t.Fatalf("hostnames: %+v", rn.Hostnames)
	}
	if len(rn.Matches) != 1 || rn.Matches[0].PathValue != "/api/share" || rn.Matches[0].Method != "GET" {
		t.Fatalf("matches: %+v", rn.Matches)
	}
	if len(rn.Backends) != 1 || rn.Backends[0].Name != "share-api" || rn.Backends[0].Port != 8080 || rn.Backends[0].Weight != 100 {
		t.Fatalf("backends: %+v", rn.Backends)
	}
	// Backend namespace defaults to the route's namespace when omitted.
	if rn.Backends[0].Namespace != "apps" {
		t.Fatalf("backend ns default: %+v", rn.Backends[0])
	}
}

func TestRouteForGatewayParentRefNamespaceDefaultsToRoute(t *testing.T) {
	// parentRef without a namespace defaults to the route's namespace.
	u := hrObj("r", "infra",
		[]interface{}{parentRef("eg", "", "")}, // no namespace
		[]interface{}{rule("/", "", "svc", 80, 0)},
		[]interface{}{statusParent("eg", "", "True", "True")},
		nil)
	if _, ok := RouteForGateway(u, "infra", "eg"); !ok {
		t.Fatal("parentRef ns should default to route ns (infra)")
	}
	if _, ok := RouteForGateway(u, "other", "eg"); ok {
		t.Fatal("must not attach to a gateway in a different namespace")
	}
}

func TestRouteForGatewayNotAttached(t *testing.T) {
	u := hrObj("r", "apps",
		[]interface{}{parentRef("some-other", "apps", "")},
		[]interface{}{rule("/", "", "svc", 80, 0)},
		nil, nil)
	if _, ok := RouteForGateway(u, "apps", "eg"); ok {
		t.Fatal("should not attach")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gwapi/ -run TestRouteForGateway -v`
Expected: FAIL — `RouteForGateway` undefined.

- [ ] **Step 3: Implement `internal/gwapi/route.go`**

```go
package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// RouteForGateway parses an HTTPRoute and, if it attaches to the given Gateway
// (by parentRef, namespace defaulting to the route's), returns the RouteNode with
// Accepted/ResolvedRefs scoped to THAT parent. ok=false when it does not attach.
// Services/Pods are filled later by the fleet layer.
func RouteForGateway(u *unstructured.Unstructured, gwNamespace, gwName string) (RouteNode, bool) {
	routeNS := u.GetNamespace()

	parents, _, _ := unstructured.NestedSlice(u.Object, "spec", "parentRefs")
	attached := false
	for _, p := range parents {
		m, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		ns, _ := m["namespace"].(string)
		if ns == "" {
			ns = routeNS
		}
		// kind defaults to Gateway; group to gateway.networking.k8s.io.
		kind, _ := m["kind"].(string)
		if kind != "" && kind != "Gateway" {
			continue
		}
		if name == gwName && ns == gwNamespace {
			attached = true
			break
		}
	}
	if !attached {
		return RouteNode{}, false
	}

	rn := RouteNode{Namespace: routeNS, Name: u.GetName()}
	rn.Hostnames, _, _ = unstructured.NestedStringSlice(u.Object, "spec", "hostnames")

	rules, _, _ := unstructured.NestedSlice(u.Object, "spec", "rules")
	for _, r := range rules {
		rm, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		matches, _, _ := unstructured.NestedSlice(rm, "matches")
		for _, mt := range matches {
			mm, ok := mt.(map[string]interface{})
			if !ok {
				continue
			}
			match := Match{}
			match.Method, _ = mm["method"].(string)
			if pth, ok := mm["path"].(map[string]interface{}); ok {
				match.PathType, _ = pth["type"].(string)
				match.PathValue, _ = pth["value"].(string)
			}
			rn.Matches = append(rn.Matches, match)
		}
		brefs, _, _ := unstructured.NestedSlice(rm, "backendRefs")
		for _, b := range brefs {
			bm, ok := b.(map[string]interface{})
			if !ok {
				continue
			}
			be := Backend{}
			be.Name, _ = bm["name"].(string)
			be.Kind, _ = bm["kind"].(string)
			if be.Kind == "" {
				be.Kind = "Service"
			}
			be.Namespace, _ = bm["namespace"].(string)
			if be.Namespace == "" {
				be.Namespace = routeNS
			}
			if p, ok := bm["port"].(int64); ok {
				be.Port = int32(p)
			}
			if w, ok := bm["weight"].(int64); ok {
				be.Weight = int32(w)
			}
			rn.Backends = append(rn.Backends, be)
		}
	}

	// Scope status to this Gateway's parent entry.
	rn.Accepted, rn.ResolvedRefs = parentStatus(u.Object, gwNamespace, gwName, routeNS)
	return rn, true
}

// parentStatus reads status.parents[] and returns Accepted/ResolvedRefs for the
// entry whose parentRef matches the given Gateway (namespace defaulting to the
// route's). Returns false,false when no matching parent status exists yet.
func parentStatus(obj map[string]interface{}, gwNamespace, gwName, routeNS string) (accepted, resolved bool) {
	sps, _, _ := unstructured.NestedSlice(obj, "status", "parents")
	for _, sp := range sps {
		spm, ok := sp.(map[string]interface{})
		if !ok {
			continue
		}
		pr, ok := spm["parentRef"].(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := pr["name"].(string)
		ns, _ := pr["namespace"].(string)
		if ns == "" {
			ns = routeNS
		}
		if name != gwName || ns != gwNamespace {
			continue
		}
		conds, _, _ := unstructured.NestedSlice(spm, "conditions")
		for _, c := range conds {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			t, _ := cm["type"].(string)
			s, _ := cm["status"].(string)
			switch t {
			case "Accepted":
				accepted = s == "True"
			case "ResolvedRefs":
				resolved = s == "True"
			}
		}
		return accepted, resolved
	}
	return false, false
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gwapi/ -v`
Expected: PASS (all gwapi tests).

- [ ] **Step 5: Commit**

```bash
git add internal/gwapi/route.go internal/gwapi/route_test.go
git commit -m "feat(gwapi): RouteForGateway - parse + attach + per-gateway-scoped status"
```

---

## Task 3: `ClusterConn.ListGateways` + `GetGatewayTopology`

**Files:**
- Create: `internal/fleet/gateway.go`, `internal/fleet/gateway_test.go`
- Modify: `internal/fleet/conn.go` (`Conn` interface), `internal/fleet/registry_test.go` (`fakeConn`)

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/gateway_test.go`:

```go
package fleet

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
)

func gwGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"}
}
func hrGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
}

func gw(name, ns string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway",
		"metadata": map[string]interface{}{"name": name, "namespace": ns},
		"spec":     map[string]interface{}{"gatewayClassName": "envoy-gateway", "listeners": []interface{}{map[string]interface{}{"name": "http", "protocol": "HTTP", "port": int64(80)}}},
		"status":   map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}, map[string]interface{}{"type": "Programmed", "status": "True"}}},
	}}
}

func hr(name, ns, gwName, gwNS, backend string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute",
		"metadata": map[string]interface{}{"name": name, "namespace": ns},
		"spec": map[string]interface{}{
			"parentRefs": []interface{}{map[string]interface{}{"name": gwName, "namespace": gwNS}},
			"rules":      []interface{}{map[string]interface{}{"backendRefs": []interface{}{map[string]interface{}{"name": backend, "port": int64(80), "weight": int64(100)}}}},
		},
		"status": map[string]interface{}{"parents": []interface{}{map[string]interface{}{"parentRef": map[string]interface{}{"name": gwName, "namespace": gwNS}, "conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}, map[string]interface{}{"type": "ResolvedRefs", "status": "True"}}}}},
	}}
}

func TestGetGatewayTopology(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds,
		gw("eg", "infra"), hr("share", "apps", "eg", "infra", "share-api"))

	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps"},
		Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Ports: []corev1.ServicePort{{Port: 80}}},
	}
	ready := true
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{Name: "share-api-abc", Namespace: "apps", Labels: map[string]string{"kubernetes.io/service-name": "share-api"}},
		Endpoints:  []discoveryv1.Endpoint{{Conditions: discoveryv1.EndpointConditions{Ready: &ready}}, {Conditions: discoveryv1.EndpointConditions{Ready: &ready}}},
	}
	typed := typedfake.NewSimpleClientset(svc, eps)

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	if topo.Gateway.Name != "eg" || !topo.Gateway.Programmed {
		t.Fatalf("gateway: %+v", topo.Gateway)
	}
	if len(topo.Routes) != 1 || topo.Routes[0].Name != "share" || !topo.Routes[0].Accepted {
		t.Fatalf("routes: %+v", topo.Routes)
	}
	r := topo.Routes[0]
	if len(r.Services) != 1 || r.Services[0].Name != "share-api" || !r.Services[0].Resolved {
		t.Fatalf("service: %+v", r.Services)
	}
	if r.Pods.Ready != 2 || r.Pods.Total != 2 || r.Pods.Unknown {
		t.Fatalf("pods: %+v", r.Pods)
	}
}

func TestGetGatewayTopologyUnresolvedBackendWarns(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{gwGVR(): "GatewayList", hrGVR(): "HTTPRouteList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds,
		gw("eg", "infra"), hr("share", "apps", "eg", "infra", "missing-svc"))
	typed := typedfake.NewSimpleClientset() // no service

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})
	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology must still render: %v", err)
	}
	if len(topo.Routes) != 1 || topo.Routes[0].Services[0].Resolved {
		t.Fatalf("backend should be unresolved: %+v", topo.Routes)
	}
	if len(topo.Warnings) == 0 {
		t.Fatal("an unresolved backend must produce a warning")
	}
}

func TestListGatewaysServedFlag(t *testing.T) {
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{gwGVR(): "GatewayList"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, gw("eg", "infra"))
	typed := typedfake.NewSimpleClientset()
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	refs, served, err := c.ListGateways(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// The fake discovery has no Gateway API group, so served is false (fallback path).
	_ = served
	if len(refs) != 1 || refs[0].Name != "eg" || !refs[0].Programmed {
		t.Fatalf("refs: %+v", refs)
	}
}
```

NOTE: reuse the package-level `dynScheme()` helper already in the fleet test package. Add `discoveryv1 "k8s.io/api/discovery/v1"` etc. to imports as shown.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run 'TestGetGatewayTopology|TestListGateways' -v`
Expected: FAIL — `c.GetGatewayTopology` / `c.ListGateways` undefined.

- [ ] **Step 3: Implement `internal/fleet/gateway.go`**

```go
package fleet

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/gwapi"
)

const gwGroup = "gateway.networking.k8s.io"

func (c *ClusterConn) gwGVR(resource string) schema.GroupVersionResource {
	v := preferredVersion(c.typed.Discovery(), gwGroup, "v1")
	return schema.GroupVersionResource{Group: gwGroup, Version: v, Resource: resource}
}

// gatewayAPIServed reports whether the Gateway API group is advertised.
func (c *ClusterConn) gatewayAPIServed() bool {
	groups, err := c.typed.Discovery().ServerGroups()
	if err != nil || groups == nil {
		return false
	}
	for _, g := range groups.Groups {
		if g.Name == gwGroup {
			return true
		}
	}
	return false
}

// ListGateways lists Gateways (refs) and whether the Gateway API is served.
func (c *ClusterConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	served := c.gatewayAPIServed()
	list, err := c.dyn.Resource(c.gwGVR("gateways")).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, served, nil // not served / not installed → empty, no hard error
	}
	out := make([]gwapi.GatewayRef, 0, len(list.Items))
	for i := range list.Items {
		u := &unstructured.Unstructured{Object: list.Items[i].Object}
		out = append(out, gwapi.ParseGatewayRef(u))
	}
	return out, served, nil
}

// GetGatewayTopology builds the per-Gateway data path. A core failure (the Gateway
// cannot be read) returns an error; soft issues accumulate in Topology.Warnings.
func (c *ClusterConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	gwu, err := c.dyn.Resource(c.gwGVR("gateways")).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return gwapi.Topology{}, fmt.Errorf("get gateway %s/%s: %w", namespace, name, err)
	}
	topo := gwapi.Topology{Gateway: gwapi.ParseGateway(gwu)}

	hrList, err := c.dyn.Resource(c.gwGVR("httproutes")).List(ctx, metav1.ListOptions{})
	if err != nil {
		topo.Warnings = append(topo.Warnings, "could not list HTTPRoutes: "+err.Error())
		return topo, nil
	}
	for i := range hrList.Items {
		u := &unstructured.Unstructured{Object: hrList.Items[i].Object}
		rn, ok := gwapi.RouteForGateway(u, namespace, name)
		if !ok {
			continue
		}
		c.resolveBackends(ctx, &rn, &topo)
		topo.Routes = append(topo.Routes, rn)
	}
	return topo, nil
}

// resolveBackends fills a route's Services + primary Pods from the typed client,
// appending warnings for anything it can't resolve.
func (c *ClusterConn) resolveBackends(ctx context.Context, rn *gwapi.RouteNode, topo *gwapi.Topology) {
	for i, b := range rn.Backends {
		if b.Kind != "Service" {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: backend %q is a %s, not a Service", rn.Namespace, rn.Name, b.Name, b.Kind))
			continue
		}
		sn := gwapi.ServiceNode{Namespace: b.Namespace, Name: b.Name, Port: b.Port}
		svc, err := c.typed.CoreV1().Services(b.Namespace).Get(ctx, b.Name, metav1.GetOptions{})
		if err != nil {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: backend Service %s/%s not found", rn.Namespace, rn.Name, b.Namespace, b.Name))
			rn.Services = append(rn.Services, sn) // Resolved=false
			continue
		}
		sn.Resolved = true
		sn.Type = string(svc.Spec.Type)
		if len(svc.Spec.Ports) > 0 && sn.Port == 0 {
			sn.Port = svc.Spec.Ports[0].Port
		}
		rn.Services = append(rn.Services, sn)
		if i == 0 {
			rn.Pods = c.podCount(ctx, b.Namespace, b.Name, topo, rn)
		}
	}
	if len(rn.Backends) > 1 {
		topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s has %d backends; the lane shows the primary", rn.Namespace, rn.Name, len(rn.Backends)))
	}
}

func (c *ClusterConn) podCount(ctx context.Context, ns, svc string, topo *gwapi.Topology, rn *gwapi.RouteNode) gwapi.PodCount {
	slices, err := c.typed.DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{LabelSelector: "kubernetes.io/service-name=" + svc})
	if err != nil {
		topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: EndpointSlices unavailable for %s", rn.Namespace, rn.Name, svc))
		return gwapi.PodCount{Unknown: true}
	}
	pc := gwapi.PodCount{}
	for i := range slices.Items {
		for _, e := range slices.Items[i].Endpoints {
			pc.Total++
			if e.Conditions.Ready != nil && *e.Conditions.Ready {
				pc.Ready++
			}
		}
	}
	return pc
}
```

- [ ] **Step 4: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add to the `Conn` interface (after `GetInstanceDetail`) — and add the `gwapi` import:

```go
	ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error)
	GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error)
```

- [ ] **Step 5: Add `fakeConn` stubs**

In `internal/fleet/registry_test.go`, after the `GetInstanceDetail` stub (and add the `gwapi` import):

```go
func (f *fakeConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	return nil, false, nil
}
func (f *fakeConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	return gwapi.Topology{}, nil
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestGetGatewayTopology|TestListGateways|Registry' -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`.
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/gateway.go internal/fleet/gateway_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ListGateways + GetGatewayTopology (structural lane + warnings)"
```

---

## Task 4: appbridge `GatewayService`

**Files:**
- Create: `internal/appbridge/gateway_dto.go`, `internal/appbridge/gateway_service.go`, `internal/appbridge/gateway_service_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/appbridge/gateway_service_test.go`:

```go
package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/gwapi"
)

type fakeGatewayConn struct {
	refs   []gwapi.GatewayRef
	served bool
	topo   gwapi.Topology
	err    error
}

func (f *fakeGatewayConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	return f.refs, f.served, nil
}
func (f *fakeGatewayConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	return f.topo, f.err
}

func TestListGatewaysDTO(t *testing.T) {
	conn := &fakeGatewayConn{served: true, refs: []gwapi.GatewayRef{{Namespace: "infra", Name: "eg", ClassName: "envoy-gateway", Accepted: true, Programmed: true}}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	out := svc.ListGateways("x")
	if !out.GatewayAPIServed || len(out.Gateways) != 1 || out.Gateways[0].Name != "eg" {
		t.Fatalf("list: %+v", out)
	}
}

func TestGetGatewayTopologyDTO(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway:  gwapi.GatewayNode{Namespace: "infra", Name: "eg", ClassName: "envoy-gateway", Programmed: true, Listeners: []gwapi.Listener{{Name: "http", Protocol: "HTTP", Port: 80}}},
		Routes:   []gwapi.RouteNode{{Namespace: "apps", Name: "share", Accepted: true, Matches: []gwapi.Match{{PathType: "PathPrefix", PathValue: "/x"}}, Services: []gwapi.ServiceNode{{Name: "share-api", Resolved: true, Type: "ClusterIP", Port: 80}}, Pods: gwapi.PodCount{Ready: 2, Total: 2}}},
		Warnings: []string{"heads up"},
	}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")
	if d.Gateway.Name != "eg" || !d.Gateway.Programmed || len(d.Routes) != 1 {
		t.Fatalf("topology: %+v", d)
	}
	if d.Routes[0].Services[0].Name != "share-api" || d.Routes[0].Pods.Ready != 2 {
		t.Fatalf("route: %+v", d.Routes[0])
	}
	if len(d.Warnings) != 1 || d.Error != "" {
		t.Fatalf("warnings/error: %+v", d)
	}
}

func TestGetGatewayTopologyErrorSurfaced(t *testing.T) {
	conn := &fakeGatewayConn{err: context.DeadlineExceeded}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")
	if d.Error == "" {
		t.Fatalf("a core error must surface in Error, got %+v", d)
	}
}

func TestGatewayUnknownClusterEmpty(t *testing.T) {
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return nil, false })
	if out := svc.ListGateways("ghost"); out.GatewayAPIServed || len(out.Gateways) != 0 {
		t.Fatalf("want empty, got %+v", out)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestListGateways|TestGetGatewayTopology|TestGatewayUnknown' -v`
Expected: FAIL — service/DTOs undefined.

- [ ] **Step 3: Implement `internal/appbridge/gateway_dto.go`**

Every field carries an explicit lowercase/camelCase json tag matching the TS
types in Task 6 (the generated Wails bindings use these tags):

```go
package appbridge

import "github.com/moomora/klyx/internal/gwapi"

type ListenerDTO struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Hostname string `json:"hostname"`
	Port     int32  `json:"port"`
}
type PolicyRefDTO struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Summary  string `json:"summary"`
	Inferred bool   `json:"inferred"`
}
type GatewayNodeDTO struct {
	Namespace  string         `json:"namespace"`
	Name       string         `json:"name"`
	ClassName  string         `json:"className"`
	Listeners  []ListenerDTO  `json:"listeners"`
	Accepted   bool           `json:"accepted"`
	Programmed bool           `json:"programmed"`
	Policies   []PolicyRefDTO `json:"policies"`
}
type MatchDTO struct {
	PathType  string `json:"pathType"`
	PathValue string `json:"pathValue"`
	Method    string `json:"method"`
}
type BackendDTO struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Port      int32  `json:"port"`
	Weight    int32  `json:"weight"`
}
type PodCountDTO struct {
	Ready   int  `json:"ready"`
	Total   int  `json:"total"`
	Unknown bool `json:"unknown"`
}
type ServiceNodeDTO struct {
	Namespace string         `json:"namespace"`
	Name      string         `json:"name"`
	Type      string         `json:"type"`
	Port      int32          `json:"port"`
	Resolved  bool           `json:"resolved"`
	CNPs      []PolicyRefDTO `json:"cnps"`
}
type RouteNodeDTO struct {
	Namespace    string           `json:"namespace"`
	Name         string           `json:"name"`
	Hostnames    []string         `json:"hostnames"`
	Matches      []MatchDTO       `json:"matches"`
	Accepted     bool             `json:"accepted"`
	ResolvedRefs bool             `json:"resolvedRefs"`
	Backends     []BackendDTO     `json:"backends"`
	Services     []ServiceNodeDTO `json:"services"`
	Pods         PodCountDTO      `json:"pods"`
	Policies     []PolicyRefDTO   `json:"policies"`
}
type TopologyDTO struct {
	Gateway  GatewayNodeDTO `json:"gateway"`
	Routes   []RouteNodeDTO `json:"routes"`
	Warnings []string       `json:"warnings,omitempty"`
	Error    string         `json:"error,omitempty"`
}
type GatewayRefDTO struct {
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	ClassName  string `json:"className"`
	Accepted   bool   `json:"accepted"`
	Programmed bool   `json:"programmed"`
}
type GatewayListDTO struct {
	GatewayAPIServed bool            `json:"gatewayAPIServed"`
	Gateways         []GatewayRefDTO `json:"gateways"`
}

func policyDTOs(ps []gwapi.PolicyRef) []PolicyRefDTO {
	out := make([]PolicyRefDTO, 0, len(ps))
	for _, p := range ps {
		out = append(out, PolicyRefDTO{Kind: p.Kind, Name: p.Name, Summary: p.Summary, Inferred: p.Inferred})
	}
	return out
}

func toTopologyDTO(t gwapi.Topology) TopologyDTO {
	g := t.Gateway
	gd := GatewayNodeDTO{Namespace: g.Namespace, Name: g.Name, ClassName: g.ClassName, Accepted: g.Accepted, Programmed: g.Programmed, Policies: policyDTOs(g.Policies)}
	for _, l := range g.Listeners {
		gd.Listeners = append(gd.Listeners, ListenerDTO{Name: l.Name, Protocol: l.Protocol, Hostname: l.Hostname, Port: l.Port})
	}
	out := TopologyDTO{Gateway: gd, Warnings: t.Warnings}
	for _, r := range t.Routes {
		rd := RouteNodeDTO{Namespace: r.Namespace, Name: r.Name, Hostnames: r.Hostnames, Accepted: r.Accepted, ResolvedRefs: r.ResolvedRefs, Pods: PodCountDTO{Ready: r.Pods.Ready, Total: r.Pods.Total, Unknown: r.Pods.Unknown}, Policies: policyDTOs(r.Policies)}
		for _, m := range r.Matches {
			rd.Matches = append(rd.Matches, MatchDTO{PathType: m.PathType, PathValue: m.PathValue, Method: m.Method})
		}
		for _, b := range r.Backends {
			rd.Backends = append(rd.Backends, BackendDTO{Kind: b.Kind, Name: b.Name, Namespace: b.Namespace, Port: b.Port, Weight: b.Weight})
		}
		for _, s := range r.Services {
			rd.Services = append(rd.Services, ServiceNodeDTO{Namespace: s.Namespace, Name: s.Name, Type: s.Type, Port: s.Port, Resolved: s.Resolved, CNPs: policyDTOs(s.CNPs)})
		}
		out.Routes = append(out.Routes, rd)
	}
	return out
}
```

NOTE: the `json:"-"` shorthands on `GatewayNodeDTO` (Namespace/Name/ClassName/Accepted/Programmed) and the un-tagged fields on `MatchDTO`/`BackendDTO`/`PodCountDTO`/`ServiceNodeDTO`/`RouteNodeDTO`/`GatewayRefDTO` must each carry their own lowercase json tags so the generated TS bindings match the frontend types. Give every field an explicit `json:"name"` (e.g. `Namespace string \`json:"namespace"\``). Do not actually leave `json:"-"`; it is shorthand in this plan for "tag each field individually".

- [ ] **Step 4: Implement `internal/appbridge/gateway_service.go`**

```go
package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/gwapi"
)

type GatewayConn interface {
	ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error)
	GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error)
}

const gatewayTimeout = 30 * time.Second

type GatewayService struct {
	lookup func(string) (GatewayConn, bool)
}

func NewGatewayService(lookup func(string) (GatewayConn, bool)) *GatewayService {
	return &GatewayService{lookup: lookup}
}

func (s *GatewayService) ListGateways(cluster string) GatewayListDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return GatewayListDTO{Gateways: []GatewayRefDTO{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTimeout)
	defer cancel()
	refs, served, err := conn.ListGateways(ctx)
	if err != nil {
		return GatewayListDTO{Gateways: []GatewayRefDTO{}}
	}
	out := GatewayListDTO{GatewayAPIServed: served, Gateways: make([]GatewayRefDTO, 0, len(refs))}
	for _, r := range refs {
		out.Gateways = append(out.Gateways, GatewayRefDTO{Namespace: r.Namespace, Name: r.Name, ClassName: r.ClassName, Accepted: r.Accepted, Programmed: r.Programmed})
	}
	return out
}

func (s *GatewayService) GetGatewayTopology(cluster, namespace, name string) TopologyDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return TopologyDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTimeout)
	defer cancel()
	topo, err := conn.GetGatewayTopology(ctx, namespace, name)
	if err != nil {
		return TopologyDTO{Error: err.Error()}
	}
	return toTopologyDTO(topo)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -run 'TestListGateways|TestGetGatewayTopology|TestGatewayUnknown' -v` then `go test ./internal/appbridge/` and `go vet ./internal/appbridge/`.
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/gateway_dto.go internal/appbridge/gateway_service.go internal/appbridge/gateway_service_test.go
git commit -m "feat(appbridge): GatewayService - topology DTO with warnings/error"
```

---

## Task 5: Register `GatewayService` in main.go

**Files:**
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Construct + register**

In `cmd/klyx/main.go`, after the `crdSvc := appbridge.NewCRDService(...)` block, add:

```go
	gatewaySvc := appbridge.NewGatewayService(func(name string) (appbridge.GatewayConn, bool) {
		c, ok := reg.Conn(name)
		if !ok {
			return nil, false
		}
		return c, true
	})
```

Add to the `Services:` slice (after `application.NewService(crdSvc),`):

```go
				application.NewService(gatewaySvc),
```

- [ ] **Step 2: Build to verify it compiles**

Run: `make build 2>&1 | grep -vE "ld: warning|object file" | tail` (the fleet `Conn` must satisfy `appbridge.GatewayConn`).
Expected: builds clean (ignore linker warnings + the known ios scaffold).

- [ ] **Step 3: Commit**

```bash
git add cmd/klyx/main.go
git commit -m "feat: register GatewayService with the Wails app"
```

---

## Task 6: Frontend store — route.gateway + network slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `src/store/fleet.test.ts`
- Create: `cmd/klyx/frontend/src/bridge/gateway.ts`

- [ ] **Step 1: Write the failing store test**

Add to `src/store/fleet.test.ts`:

```ts
import { useFleet as uf4 } from "./fleet";

test("network gateway drill-in route + slice", () => {
  uf4.getState().openCluster("x");
  uf4.getState().setSection("network");
  uf4.getState().openGateway("infra", "eg");
  const r = uf4.getState().route;
  expect(r).toMatchObject({ name: "cluster", section: "network", gateway: { namespace: "infra", name: "eg" } });
  expect(uf4.getState().network.selected).toEqual({ namespace: "infra", name: "eg" });
  expect(uf4.getState().network.topologyLoading).toBe(true);

  uf4.getState().setTopology({ gateway: { listeners: [], policies: [] } as any, routes: [], warnings: [] });
  expect(uf4.getState().network.topology?.routes.length).toBe(0);
  expect(uf4.getState().network.topologyLoading).toBe(false);

  uf4.getState().closeGateway();
  const r2 = uf4.getState().route;
  expect(r2.name === "cluster" && r2.gateway).toBeUndefined();

  uf4.getState().setGateways({ gatewayAPIServed: true, gateways: [{ namespace: "infra", name: "eg", className: "envoy-gateway", accepted: true, programmed: true }] });
  expect(uf4.getState().network.gateways.length).toBe(1);
  expect(uf4.getState().network.served).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "network gateway"`
Expected: FAIL — `openGateway is not a function`.

- [ ] **Step 3: Implement in `src/store/fleet.ts`**

Add types (near the other DTO types):

```ts
export type GatewayRefDTO = { namespace: string; name: string; className: string; accepted: boolean; programmed: boolean };
export type GatewayListDTO = { gatewayAPIServed: boolean; gateways: GatewayRefDTO[] };
export type PolicyRefDTO = { kind: string; name: string; summary: string; inferred: boolean };
export type ListenerDTO = { name: string; protocol: string; hostname: string; port: number };
export type MatchDTO = { pathType: string; pathValue: string; method: string };
export type BackendDTO = { kind: string; name: string; namespace: string; port: number; weight: number };
export type PodCountDTO = { ready: number; total: number; unknown: boolean };
export type ServiceNodeDTO = { namespace: string; name: string; type: string; port: number; resolved: boolean; cnps: PolicyRefDTO[] };
export type GatewayNodeDTO = { namespace: string; name: string; className: string; listeners: ListenerDTO[]; accepted: boolean; programmed: boolean; policies: PolicyRefDTO[] };
export type RouteNodeDTO = { namespace: string; name: string; hostnames: string[]; matches: MatchDTO[]; accepted: boolean; resolvedRefs: boolean; backends: BackendDTO[]; services: ServiceNodeDTO[]; pods: PodCountDTO; policies: PolicyRefDTO[] };
export type TopologyDTO = { gateway: GatewayNodeDTO; routes: RouteNodeDTO[]; warnings?: string[]; error?: string };
export type GatewayRef = { namespace: string; name: string };

export type NetworkSlice = {
  served: boolean;
  gateways: GatewayRefDTO[];
  listLoading: boolean;
  selected: GatewayRef | null;
  topology: TopologyDTO | null;
  topologyLoading: boolean;
  selectedRoute: string | null; // "<ns>/<name>"
};
```

Extend the `Route` cluster variant with `gateway`:
```ts
  | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef; instance?: InstanceRef; gateway?: GatewayRef };
```

Add to `FleetState`:
```ts
  openGateway: (namespace: string, name: string) => void;
  closeGateway: () => void;
  network: NetworkSlice;
  setGatewaysLoading: () => void;
  setGateways: (l: GatewayListDTO) => void;
  setTopologyLoading: (ref: GatewayRef) => void;
  setTopology: (t: TopologyDTO) => void;
  selectRoute: (key: string | null) => void;
  clearNetwork: () => void;
```

Add to the store body:
```ts
  openGateway: (namespace, name) =>
    set((s) =>
      s.route.name === "cluster"
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "network", gateway: { namespace, name } },
            network: { ...s.network, selected: { namespace, name }, topology: null, topologyLoading: true, selectedRoute: null },
          }
        : {}),
  closeGateway: () =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section: "network" } } : {})),
  network: { served: false, gateways: [], listLoading: false, selected: null, topology: null, topologyLoading: false, selectedRoute: null },
  setGatewaysLoading: () => set((s) => ({ network: { ...s.network, listLoading: true } })),
  setGateways: (l) => set((s) => ({ network: { ...s.network, served: l.gatewayAPIServed, gateways: l.gateways ?? [], listLoading: false } })),
  setTopologyLoading: (ref) => set((s) => ({ network: { ...s.network, selected: ref, topology: null, topologyLoading: true, selectedRoute: null } })),
  setTopology: (topology) => set((s) => ({ network: { ...s.network, topology, topologyLoading: false } })),
  selectRoute: (selectedRoute) => set((s) => ({ network: { ...s.network, selectedRoute } })),
  clearNetwork: () => set((s) => ({ network: { ...s.network, selected: null, topology: null, topologyLoading: false, selectedRoute: null } })),
```

NOTE: confirm `setSection`/`openResource`/`openInstance` rebuild fresh route literals (they do) so they drop a stale `gateway`. No change needed there.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts`
Expected: all PASS.

- [ ] **Step 5: Create `src/bridge/gateway.ts`**

```ts
import { useFleet, GatewayListDTO, TopologyDTO, GatewayRef } from "../store/fleet";
import { GatewayService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listGateways(cluster: string): Promise<void> {
  useFleet.getState().setGatewaysLoading();
  const l = (await GatewayService.ListGateways(cluster)) as GatewayListDTO;
  useFleet.getState().setGateways(l ?? { gatewayAPIServed: false, gateways: [] });
}

export async function getGatewayTopology(cluster: string, ref: GatewayRef): Promise<void> {
  useFleet.getState().setTopologyLoading(ref);
  const t = (await GatewayService.GetGatewayTopology(cluster, ref.namespace, ref.name)) as TopologyDTO;
  const cur = useFleet.getState().network.selected;
  if (!cur || cur.namespace !== ref.namespace || cur.name !== ref.name) return;
  useFleet.getState().setTopology(t);
}
```

NOTE: `GatewayService` resolves only after bindings are regenerated (Task 9). Do NOT run tsc/build here.

- [ ] **Step 6: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts cmd/klyx/frontend/src/bridge/gateway.ts
git commit -m "feat(ui): network slice + route.gateway + gateway bridge"
```

---

## Task 7: `NetworkView` (Gateways list + three empty states)

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/NetworkView.tsx`, `src/cluster/NetworkView.test.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`

- [ ] **Step 1: Write the failing tests**

Create `cmd/klyx/frontend/src/cluster/NetworkView.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { NetworkView } from "./NetworkView";

vi.mock("../bridge/gateway", () => ({ listGateways: vi.fn(async () => {}), getGatewayTopology: vi.fn(async () => {}) }));

function net(over: Partial<ReturnType<typeof useFleet.getState>["network"]> = {}) {
  useFleet.setState({ route: { name: "cluster", cluster: "x", section: "network" }, network: { served: true, gateways: [], listLoading: false, selected: null, topology: null, topologyLoading: false, selectedRoute: null, ...over } });
}

beforeEach(() => vi.clearAllMocks());

describe("NetworkView", () => {
  it("shows 'Gateway API not installed' when not served", () => {
    net({ served: false, gateways: [] });
    const { getByText } = render(<NetworkView cluster="x" />);
    expect(getByText(/Gateway API is not installed/i)).toBeTruthy();
  });

  it("shows 'No Gateways' when served but empty", () => {
    net({ served: true, gateways: [] });
    const { getByText } = render(<NetworkView cluster="x" />);
    expect(getByText(/No Gateways found/i)).toBeTruthy();
  });

  it("lists gateways and selecting one opens the topology route", () => {
    net({ served: true, gateways: [{ namespace: "infra", name: "eg", className: "envoy-gateway", accepted: true, programmed: true }] });
    const { getByText } = render(<NetworkView cluster="x" />);
    fireEvent.click(getByText("eg"));
    const r = useFleet.getState().route;
    expect(r.name === "cluster" && r.gateway).toEqual({ namespace: "infra", name: "eg" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkView.test.tsx`
Expected: FAIL — cannot find module `./NetworkView`.

- [ ] **Step 3: Implement `src/cluster/NetworkView.tsx`**

```tsx
import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import { listGateways } from "../bridge/gateway";
import { NetworkTopology } from "./NetworkTopology";

const empty: React.CSSProperties = { padding: 24, color: "var(--color-text-secondary)", fontSize: 13 };

export function NetworkView({ cluster }: { cluster: string }) {
  const route = useFleet((s) => s.route);
  const net = useFleet((s) => s.network);
  const openGateway = useFleet((s) => s.openGateway);

  const gateway = route.name === "cluster" ? route.gateway : undefined;

  useEffect(() => {
    if (!gateway) listGateways(cluster).catch((e) => console.error("listGateways", e));
  }, [cluster, gateway]);

  if (gateway) return <NetworkTopology cluster={cluster} gateway={gateway} />;

  if (net.listLoading && net.gateways.length === 0) return <div style={empty}>Loading Gateways…</div>;
  if (!net.served) return <div style={empty}>Gateway API is not installed on this cluster.</div>;
  if (net.gateways.length === 0) return <div style={empty}>No Gateways found.</div>;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
        <b style={{ color: "var(--color-text-primary)" }}>{net.gateways.length}</b> gateways
      </div>
      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
        {net.gateways.map((g) => (
          <div key={`${g.namespace}/${g.name}`} onClick={() => openGateway(g.namespace, g.name)}
            style={{ display: "grid", gridTemplateColumns: "16px 1fr 130px 90px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12, cursor: "pointer" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }} />
            <span style={{ fontFamily: "var(--font-mono)" }}>{g.namespace}/{g.name}</span>
            <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>{g.className}</span>
            <span style={{ fontSize: 11, color: g.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }}>{g.programmed ? "programmed" : "pending"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire `ClusterDetail.tsx`**

Add the import:
```tsx
import { NetworkView } from "./NetworkView";
```
Add a branch before the final `Placeholder` return:
```tsx
  if (route.section === "network") return <NetworkView cluster={cluster.name} />;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkView.test.tsx`
Expected: FAIL initially because `./NetworkTopology` does not exist yet — create a minimal stub so this task compiles, OR implement Task 8 first. To keep tasks independent: create a one-line stub `src/cluster/NetworkTopology.tsx` now:

```tsx
export function NetworkTopology(_: { cluster: string; gateway: { namespace: string; name: string } }) { return null; }
```
Re-run: PASS (3 tests). Task 8 replaces the stub with the real view.

- [ ] **Step 6: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/cluster/NetworkView.tsx cmd/klyx/frontend/src/cluster/NetworkView.test.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx
git commit -m "feat(ui): NetworkView - gateways list + three empty states"
```

---

## Task 8: `NetworkTopology` (columnar lanes + warnings)

**Files:**
- Modify (replace stub): `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`
- Create: `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, TopologyDTO, GatewayRef } from "../store/fleet";
import { NetworkTopology } from "./NetworkTopology";

vi.mock("../bridge/gateway", () => ({ getGatewayTopology: vi.fn(async () => {}), listGateways: vi.fn(async () => {}) }));
import { getGatewayTopology } from "../bridge/gateway";

const gateway: GatewayRef = { namespace: "infra", name: "eg" };
const topo: TopologyDTO = {
  gateway: { namespace: "infra", name: "eg", className: "envoy-gateway", accepted: true, programmed: true, listeners: [{ name: "https", protocol: "HTTPS", hostname: "", port: 443 }], policies: [] },
  routes: [
    { namespace: "apps", name: "share", hostnames: ["share.example.com"], matches: [{ pathType: "PathPrefix", pathValue: "/api/share", method: "GET" }], accepted: true, resolvedRefs: true, backends: [{ kind: "Service", name: "share-api", namespace: "apps", port: 8080, weight: 100 }], services: [{ namespace: "apps", name: "share-api", type: "ClusterIP", port: 8080, resolved: true, cnps: [] }], pods: { ready: 3, total: 3, unknown: false }, policies: [] },
  ],
  warnings: ["route apps/share has 2 backends; the lane shows the primary"],
};

function seed(t: TopologyDTO | null, loading = false) {
  useFleet.setState({ network: { served: true, gateways: [], listLoading: false, selected: gateway, topology: t, topologyLoading: loading, selectedRoute: null } });
}

beforeEach(() => { vi.clearAllMocks(); seed(topo); });

describe("NetworkTopology", () => {
  it("renders the gateway + route + service + pods lane", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText("eg")).toBeTruthy();
    expect(getByText("share")).toBeTruthy();
    expect(getByText("share-api")).toBeTruthy();
    expect(getByText(/3 \/ 3/)).toBeTruthy();
  });

  it("surfaces warnings", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/shows the primary/i)).toBeTruthy();
  });

  it("clicking a route selects it (detail panel)", () => {
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    fireEvent.click(getByText("share"));
    expect(useFleet.getState().network.selectedRoute).toBe("apps/share");
    expect(getByText(/PathPrefix/)).toBeTruthy();
  });

  it("shows the error block when topology.error is set", () => {
    seed({ gateway: topo.gateway, routes: [], error: "get gateway failed" });
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/get gateway failed/i)).toBeTruthy();
  });

  it("shows no-routes empty state", () => {
    seed({ gateway: topo.gateway, routes: [], warnings: [] });
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/No HTTPRoutes attached/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx`
Expected: FAIL (the stub renders null).

- [ ] **Step 3: Replace `src/cluster/NetworkTopology.tsx`**

```tsx
import { useEffect } from "react";
import { useFleet, GatewayRef, RouteNodeDTO } from "../store/fleet";
import { getGatewayTopology } from "../bridge/gateway";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const nb: React.CSSProperties = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "8px 9px", minWidth: 0 };
const lab: React.CSSProperties = { fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: 3 };
const nm: React.CSSProperties = { fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", ...ellipsis };
const chev: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-tertiary)" };

const routeKey = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;
const dot = (ok: boolean) => (ok ? "var(--color-text-success)" : "var(--color-text-danger)");

export function NetworkTopology({ cluster, gateway }: { cluster: string; gateway: GatewayRef }) {
  const net = useFleet((s) => s.network);
  const selectRoute = useFleet((s) => s.selectRoute);

  useEffect(() => {
    void getGatewayTopology(cluster, gateway);
    return () => useFleet.getState().clearNetwork();
  }, [cluster, gateway.namespace, gateway.name]);

  const isCurrent = net.selected && net.selected.namespace === gateway.namespace && net.selected.name === gateway.name;
  const t = isCurrent ? net.topology : null;

  if (net.topologyLoading && !t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading topology…</div>;
  if (!t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Could not load the topology.</div>;

  const selected = t.routes.find((r) => routeKey(r) === net.selectedRoute) ?? null;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{t.gateway.name}</div>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: t.gateway.programmed ? "var(--color-background-success)" : "var(--color-background-warning)", color: t.gateway.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }}>{t.gateway.programmed ? "programmed" : "pending"}</span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t.gateway.className}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => void getGatewayTopology(cluster, gateway)} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>Refresh</button>
      </div>

      {t.error && (
        <div style={{ marginBottom: 12, padding: "8px 10px", fontSize: 12, borderRadius: 4, background: "var(--color-background-danger)", color: "var(--color-text-danger)", border: "0.5px solid var(--color-border-danger)" }}>{t.error}</div>
      )}

      {t.routes.length === 0 && !t.error ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No HTTPRoutes attached to this Gateway.</div>
      ) : (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "14px 12px" }}>
          {t.routes.map((r) => {
            const svc = r.services[0];
            return (
              <div key={routeKey(r)} style={{ display: "grid", gridTemplateColumns: "150px 20px 1fr 20px 130px 20px 130px", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
                <div style={nb}>
                  <div style={lab}>gateway</div><div style={nm}>{t.gateway.name}</div>
                  <div style={{ fontSize: 9, color: "var(--color-text-secondary)", marginTop: 2 }}>{t.gateway.listeners.map((l) => `${l.protocol}:${l.port}`).join(" · ")}</div>
                </div>
                <div style={chev}>›</div>
                <div style={{ ...nb, borderColor: "var(--color-border-info)", cursor: "pointer", boxShadow: net.selectedRoute === routeKey(r) ? "0 0 0 1px var(--color-text-info)" : undefined }} onClick={() => selectRoute(routeKey(r))}>
                  <div style={{ ...lab, color: "var(--color-text-info)" }}>httproute</div>
                  <div style={{ ...nm, color: "var(--color-text-info)" }}>{r.name}</div>
                  <div style={{ fontSize: 9, marginTop: 2, ...ellipsis }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: dot(r.accepted), display: "inline-block", marginRight: 4 }} />{r.accepted ? "accepted" : "rejected"} · {r.matches[0]?.pathValue ?? "/"}</div>
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>service</div>
                  <div style={nm}>{svc ? svc.name : "—"}</div>
                  <div style={{ fontSize: 9, color: svc?.resolved ? "var(--color-text-secondary)" : "var(--color-text-danger)", marginTop: 2 }}>{!svc ? "no backend" : svc.resolved ? `${svc.type} :${svc.port}` : "unresolved"}{r.backends.length > 1 ? ` · +${r.backends.length - 1}` : ""}</div>
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>pods</div>
                  <div style={nm}>{r.pods.unknown ? "unknown" : `${r.pods.ready} / ${r.pods.total}`}</div>
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-secondary)", fontSize: 10, color: "var(--color-text-tertiary)" }}>⬡ ClusterMesh: not shown yet (arrives in a later slice)</div>
        </div>
      )}

      {t.warnings && t.warnings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {t.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--color-text-warning)", padding: "2px 0" }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {selected && <RouteDetail route={selected} />}
    </div>
  );
}

function RouteDetail({ route }: { route: RouteNodeDTO }) {
  return (
    <div style={{ marginTop: 12, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "10px 12px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: "var(--color-text-info)" }}>↳</span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12 }}>{route.name}</span>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-secondary)" }}>HTTPRoute</span>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: route.accepted ? "var(--color-background-success)" : "var(--color-background-danger)", color: route.accepted ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{route.accepted ? "accepted" : "rejected"} · {route.resolvedRefs ? "resolvedRefs" : "unresolved"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11, fontFamily: "var(--font-mono)" }}>
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 5 }}>matches</div>
          {route.matches.map((m, i) => (<div key={i}>{m.pathType} {m.pathValue}{m.method ? ` · ${m.method}` : ""}</div>))}
          {route.hostnames.length > 0 && <div style={{ color: "var(--color-text-secondary)", marginTop: 4 }}>hostnames: {route.hostnames.join(", ")}</div>}
        </div>
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 5 }}>backends</div>
          {route.backends.map((b, i) => (<div key={i}>{b.name}:{b.port}{b.weight ? ` · weight ${b.weight}` : ""}</div>))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx` then `npx vitest run` (whole suite green).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): NetworkTopology - columnar lanes, route detail, warnings"
```

---

## Task 9: Breadcrumb + bindings + build + verification

**Files:**
- Modify: `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` + `Breadcrumb.test.tsx`

- [ ] **Step 1: Add the gateway crumb (failing test first)**

Append to `src/chrome/Breadcrumb.test.tsx` (inside the existing `describe`):

```tsx
  it("shows the gateway crumb when a gateway is selected", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "network", gateway: { namespace: "infra", name: "eg" } } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("eg")).toBeTruthy();
    expect(getByText("Network")).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/chrome/Breadcrumb.test.tsx`
Expected: FAIL — no `eg` crumb.

- [ ] **Step 3: Wire `Breadcrumb.tsx`**

Add `closeGateway` to the selectors:
```tsx
  const closeGateway = useFleet((s) => s.closeGateway);
```
After the section crumb block (and the existing resource/instance blocks), add a gateway block:
```tsx
          {route.section === "network" && route.gateway && (
            <>
              <span>/</span>
              <span style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>{route.gateway.name}</span>
            </>
          )}
```
And make the `Network` section crumb a back button when a gateway is selected. The section label is currently a `<span>` (for non-resource sections). Change the section-label render so that, when `route.section === "network" && route.gateway`, it is a button calling `closeGateway`:
```tsx
          {route.resource ? (
            <button onClick={closeResource} style={crumbBtn}>{SECTION_LABELS[route.section]}</button>
          ) : route.section === "network" && route.gateway ? (
            <button onClick={closeGateway} style={crumbBtn}>{SECTION_LABELS[route.section]}</button>
          ) : (
            <span style={{ color: "var(--color-text-primary)" }}>{SECTION_LABELS[route.section]}</span>
          )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/chrome/Breadcrumb.test.tsx`
Expected: PASS.

- [ ] **Step 5: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, clean.

- [ ] **Step 6: Regenerate bindings + frontend suite + native build**

```bash
cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
grep -rn "GetGatewayTopology" frontend/bindings/github.com/moomora/klyx/internal/appbridge/ | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show `GetGatewayTopology`; vitest green; tsc clean; build exit 0.

- [ ] **Step 7: Commit + native handoff**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/chrome/Breadcrumb.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx
git commit -m "feat(ui): network gateway breadcrumb crumb + back"
```

Native handoff (owner): on `homelab-nelli`, open the cluster → **Network** → confirm the Gateways list, select the Envoy Gateway → the lane renders Gateway → HTTPRoutes → Services → Pods with correct programmed/accepted status and real pod counts; a route with a missing backend shows the unresolved marker + a warning; clicking a route opens the detail panel; the breadcrumb `Network` crumb returns to the list.

---

## Self-review notes

- **Spec coverage (M5-a portion):** §2 model + parsing → Tasks 1-2. §3 fleet (ListGateways served flag, GetGatewayTopology, EndpointSlices, warnings, error) → Task 3. §4 appbridge (warnings/error, GatewayList served flag) → Task 4. §5 nav (3 empty states, lane, route detail, warnings banner, capability gate) → Tasks 6-9. §6 testing (cross-ns parentRef, omitted backend ns, sectionName, accepted-by-one-rejected-by-another, unresolved backend) → Tasks 2-3. Policies (CTP/BTP/CNP), the policy chips, and CNP/CCNP `inferred` are **M5-b**, not this plan.
- **No silent zero-state:** `GetGatewayTopology` errors only on a core failure (→ `Error` in the DTO); soft issues (unresolved backend, missing EndpointSlices, multi-backend, non-Service backend) accumulate in `Warnings` and the lane still renders. Decision #10 honoured.
- **Per-gateway-scoped status (decision #14):** `RouteForGateway` + `parentStatus` scope Accepted/ResolvedRefs to this Gateway's parentRef; `TestRouteForGatewayAttachesAndScopesStatus` proves accepted-by-this / rejected-by-other.
- **Multi-backend (decision #11):** `RouteNode.Services []` + `Backends []`; the lane shows the primary + `+N`, the detail lists all; a warning notes the collapse.
- **Three empty states (decision #12):** not-served / no-gateways / no-routes, via `GatewayListDTO.gatewayAPIServed` and the topology's empty routes.
- **Binding timing:** `bridge/gateway.ts` references `GatewayService` before Task 9 regenerates bindings; vitest mocks the bridge; full tsc/build is Task 9.
- **Type consistency:** `gwapi` model → DTOs (lowercase json tags - flagged in Task 4) → TS types in Task 6 match field-for-field (`gatewayAPIServed`, `services`, `pods.unknown`, `resolvedRefs`). `ListGateways(ctx) ([]gwapi.GatewayRef, bool, error)` identical across `Conn`, `GatewayConn`, `ClusterConn`, both fakes.
- **NetworkTopology stub:** Task 7 creates a 1-line `NetworkTopology` stub so `NetworkView` compiles independently; Task 8 replaces it. Flagged so the engineer doesn't think it's dead code.
