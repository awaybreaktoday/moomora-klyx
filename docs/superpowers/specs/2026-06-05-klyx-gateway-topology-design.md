# Klyx M5 design (Gateway API topology)

Date: 2026-06-05
Status: approved design, ready for plan
Scope: M5. The marquee feature - render the Gateway API data path as a graph, not
a CRD list (design principle 3). A per-Gateway columnar topology
(Gateway → HTTPRoute → Service → Pods) with policies attached at the correct
node and a route detail panel. Reference: mockup 3 (`docs/mockups.html` #m3) and
the approved brainstorm mockup. Architecture: Approach A (server-side topology
build in Go, snapshot, no watch). Layout: deterministic columnar lanes (no graph
library).

ClusterMesh edges (principle 4) and inline observability (principle 5) are
explicitly deferred (M5-c / M7).

## 1. Scope, navigation, decomposition

The **Network** section of a cluster (currently a placeholder) renders when the
cluster's network capability is present (`networkTier != "Absent"`). It lists the
cluster's **Gateways**; an empty list yields a clear empty state ("No Gateway API
/ no Gateways on this cluster"), so no separate Gateway-API capability field is
needed. Clicking a Gateway opens its **columnar topology**:
the Gateway pinned left (listeners + status + attached ClientTrafficPolicy), one
lane per attached **HTTPRoute** (path matches + status + attached
BackendTrafficPolicy/SecurityPolicy), each route's backend **Service**, and the
backing **Pods** (ready/total, with best-effort CiliumNetworkPolicy). Clicking a
route node opens a **detail panel** below (match / backend / attached policies /
status). Snapshot on open, refresh button, no watch.

Breadcrumb: `Fleet / <cluster> / Network / <gateway>`; the route detail is a
selection within the topology, not a route-level route.

In scope (M5): Gateways list, per-Gateway columnar lane (Gateway/HTTPRoute/
Service/Pods with status), policy attachment (CTP/BTP/SecurityPolicy by
`targetRef`, CNP best-effort by label), route detail panel, capability gate,
cluster-scoped handling, refresh.

Out of scope (deferred): GRPCRoute/TCPRoute (HTTPRoute only for v1), ClusterMesh
cross-cluster edges (M5-c), inline observability metrics (M7), editing, live
watch.

**Plan decomposition** (one spec, likely two plans for native-verify checkpoints):
- **M5-a**: the structural lane - Network section, Gateways list, capability gate,
  the columnar Gateway→HTTPRoute→Service→Pods topology with status. No policies.
- **M5-b**: policy attachment (CTP/BTP/SecurityPolicy/CNP at the right node) + the
  route detail panel.

## 2. Data model + resolution (`internal/gwapi`, new pure package)

The cross-referencing - the fiddly part - lives here, fully unit-tested from
unstructured fixtures.

```go
type Topology struct {
    Gateway GatewayNode
    Routes  []RouteNode // one lane each, ordered by name
}
type GatewayNode struct {
    Namespace, Name, ClassName string
    Listeners  []Listener   // Name, Protocol, Port, Hostname
    Accepted   bool
    Programmed bool
    Policies   []PolicyRef  // targetRef → this Gateway (e.g. ClientTrafficPolicy)
}
type RouteNode struct {
    Namespace, Name string
    Hostnames    []string
    Matches      []Match     // Path{Type,Value}, Method
    Accepted     bool        // status.parents[].conditions Accepted
    ResolvedRefs bool        // status.parents[].conditions ResolvedRefs
    Backends     []Backend   // Kind, Name, Port, Weight
    Policies     []PolicyRef // targetRef → this HTTPRoute (BTP, SecurityPolicy)
    Service      ServiceNode // primary backend, resolved
    Pods         PodCount    // Ready, Total
}
type ServiceNode struct {
    Namespace, Name, Type string // ClusterIP/LoadBalancer/...
    Port int32
    CNPs []PolicyRef // CiliumNetworkPolicies whose endpointSelector matches (best-effort)
}
type Listener struct { Name, Protocol, Hostname string; Port int32 }
type Match     struct { PathType, PathValue, Method string }
type Backend   struct { Kind, Name string; Port, Weight int32 }
type PodCount  struct { Ready, Total int }
type PolicyRef struct { Kind, Name, Summary string } // Summary e.g. "h2 16mb", "retries 3"
type GatewayRef struct { Namespace, Name, ClassName string; Accepted, Programmed bool }
```

Pure functions:
- `ParseGateway(u) GatewayNode` - `spec.gatewayClassName`, `spec.listeners[]`,
  `status.conditions` (Accepted/Programmed).
- `ParseHTTPRoute(u) RouteNode` - `spec.hostnames`, `spec.rules[].matches[]`
  (path type/value, method), `spec.rules[].backendRefs[]`, and
  `status.parents[].conditions` (Accepted/ResolvedRefs).
- `RouteParents(u) []ParentRef` - `spec.parentRefs[]` (group/kind/name, namespace
  defaulting to the route's), used to link routes to a Gateway.
- `PolicyTargets(u) []TargetRef` - `spec.targetRefs[]` (and legacy singular
  `spec.targetRef`) - `{group, kind, name, sectionName}`. Used to attach a parsed
  policy to the matching Gateway/HTTPRoute/Service node.
- `PolicySummary(kind string, u) string` - a short chip label per policy kind
  (e.g. ClientTrafficPolicy HTTP2 + a connection limit → "h2 16mb"); falls back to
  the policy name.
- `CNPSelector(u) map[string]string` - a CiliumNetworkPolicy's
  `spec.endpointSelector.matchLabels`, for best-effort service matching.
- Wiring: `linkRoutes(gw, routes)` keeps routes whose `parentRefs` reference the
  Gateway; `attachPolicies(topology, policies)` places each policy on the node its
  `targetRef` names; `attachCNPs(service, cnps)` attaches a CNP when its
  `endpointSelector.matchLabels` is a subset of the Service's `spec.selector`.

`gwapi` is given already-parsed pieces + the Service/Pod data; it does the
resolution. No client-go dependency beyond `unstructured`.

## 3. Data layer (`internal/fleet`)

Two methods on `ClusterConn` (added to the `Conn` interface + `fakeConn`):

```go
func (c *ClusterConn) ListGateways(ctx) ([]gwapi.GatewayRef, error)
func (c *ClusterConn) GetGatewayTopology(ctx, namespace, name string) (gwapi.Topology, error)
```

GVRs (preferred version resolved via the existing `preferredVersion` helper):
- `gateway.networking.k8s.io`: `gateways`, `httproutes` (v1).
- `gateway.envoyproxy.io`: `clienttrafficpolicies`, `backendtrafficpolicies`,
  `securitypolicies` (v1alpha1).
- `cilium.io`: `ciliumnetworkpolicies` (namespaced) + `ciliumclusterwidenetworkpolicies`
  (cluster-scoped) (v2).

`ListGateways` lists Gateways (dynamic), parses ref + status.

`GetGatewayTopology(ns, name)`:
1. Dynamic Get the Gateway; `gwapi.ParseGateway`.
2. Dynamic list HTTPRoutes (all namespaces); keep those whose `parentRefs`
   reference this Gateway (`gwapi.linkRoutes`); `gwapi.ParseHTTPRoute` each.
3. For each route's primary backend Service: typed Get the `Service` (name/type/
   port) and list `EndpointSlices` (discovery.k8s.io/v1, label
   `kubernetes.io/service-name=<svc>`) → ready/total pod counts.
4. Dynamic list CTP/BTP/SecurityPolicy; `gwapi.attachPolicies` by `targetRef`.
5. Dynamic list CiliumNetworkPolicy (+ clusterwide); `gwapi.attachCNPs` by
   label-subset against each Service's selector (best-effort).
6. Return the assembled `gwapi.Topology`.

Snapshot; no watch. A missing optional CRD group (e.g. no Envoy policies, or no
Cilium) degrades to empty policies, never fails the topology. Bounded context.

## 4. appbridge (`GatewayService`)

A new bound service (registered in `main.go`), request/response (no push):

```go
type TopologyDTO struct {
    Gateway GatewayNodeDTO  `json:"gateway"`
    Routes  []RouteNodeDTO  `json:"routes"`
}
// ...NodeDTOs mirror the gwapi model with json tags; status as booleans;
// PolicyRefDTO{kind,name,summary}; PodCountDTO{ready,total}.
type GatewayRefDTO struct { Namespace, Name, ClassName string; Accepted, Programmed bool }

func (s *GatewayService) ListGateways(cluster string) []GatewayRefDTO
func (s *GatewayService) GetGatewayTopology(cluster, namespace, name string) TopologyDTO
```

`GatewayConn` interface (`ListGateways` + `GetGatewayTopology`) satisfied by the
fleet `Conn`; appbridge fake stubs it. Empty/zero DTO on cluster miss or error.
Tested with a fake conn.

## 5. Frontend (`NetworkTopology` + wiring)

- **Nav / capability gate**: the `network` section renders `NetworkView` when the
  cluster's network capability is present (Gateway API detected), else a clear
  empty state ("No Gateway API installed on this cluster"). `NetworkView` lists
  Gateways; selecting one sets a route-carried `gateway` ref and renders
  `NetworkTopology`.
- **`NetworkTopology.tsx`**: deterministic CSS-grid columnar lanes - Gateway
  pinned left (listeners, status badges, CTP chip), one row per HTTPRoute
  (accepted/resolvedRefs dot, path, BTP/SecurityPolicy chips), backend Service,
  Pods (ready/total, CNP chip). Chevrons between columns. Policy chips
  colour-coded by kind (CTP/BTP/SecurityPolicy/CNP). A muted ClusterMesh
  placeholder row. Clicking a route node selects it → detail panel below
  (match / backend / attached policies / status + a "view YAML" affordance that
  reuses the M4-c instance detail by routing to the route's resource). Refresh
  re-fetches. Loading / empty (no Gateways) / no-Gateway-API states.
- **Route**: the cluster route gains an optional `gateway?: { namespace, name }`
  (sibling to `resource`/`instance`); `setSection`/section changes drop it (same
  pattern as M4). A topology slice holds `gatewayList`, `selectedGateway`,
  `topology`, `selectedRoute`, `loading`, with a ref guard.
- **Bridge**: `listGateways(cluster)`, `getGatewayTopology(cluster, ns, name)`.
- Breadcrumb: `… / Network / <gateway>`; the `Network` crumb returns to the
  Gateways list.

## 6. Testing

- **`internal/gwapi`** (pure, fixtures): `ParseGateway`/`ParseHTTPRoute` (listeners,
  matches, backends, status conditions); `RouteParents` + `linkRoutes`
  (cross-namespace parentRef matching); `PolicyTargets` + `attachPolicies`
  (CTP→gateway, BTP→route, both `targetRefs` and legacy `targetRef`);
  `PolicySummary`; `CNPSelector` + `attachCNPs` (label-subset match + non-match).
- **`internal/fleet`**: `GetGatewayTopology` against the dynamic fake (gateway +
  two httproutes + CTP/BTP) and the typed fake (Services + EndpointSlices →
  ready/total); a missing-policy-group path degrading to empty; the cluster-scoped
  CNP path; `ListGateways`.
- **appbridge**: `TopologyDTO`/`GatewayRefDTO` mapping via a fake conn.
- **frontend (vitest)**: lane render (gateway + routes + services + pods) from a
  mocked bridge; policy chips on the right nodes; route-click → detail panel;
  capability-gated empty state; the Gateways list → select flow.
- **Native handoff**: `homelab-nelli`'s Envoy Gateway - confirm the lane renders
  the real Gateway/routes/services/pods with correct status, the CTP/BTP chips
  land on the right nodes, and the route detail panel shows match/backend/policies.

## 7. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Deterministic columnar lanes, no graph library | The data path has a fixed shape (Gateway→Route→Service→Pods); deterministic CSS layout matches the mockup and removes graph-lib risk |
| 2 | Server-side topology build in `internal/gwapi` (pure) | parentRef/backendRef/targetRef/label resolution is real logic that deserves Go unit tests; the frontend stays a dumb renderer |
| 3 | Snapshot + refresh, no watch | Topology changes rarely; consistent with M4; avoids standing watch over Gateway API objects |
| 4 | Per-Gateway scope as the entry | A Gateway is the ingress entrypoint; showing everything flowing through it is the natural data-path story |
| 5 | HTTPRoute only for v1 | The owner's Envoy Gateway setup is HTTPRoute; GRPCRoute/TCPRoute are a clean later add |
| 6 | CTP/BTP/SecurityPolicy by `targetRef` (precise); CNP best-effort by label | Envoy policies use Gateway API policy-attachment (clean); Cilium CNP attaches to pods by `endpointSelector`, inherently a heuristic |
| 7 | EndpointSlices (not Endpoints) for pod counts | The modern, non-deprecated source on k8s 1.36 |
| 8 | ClusterMesh + observability deferred (M5-c / M7) | ClusterMesh is single-cluster-undogfoodable on the homelab; observability is its own milestone |
| 9 | Two plans under one spec (lane, then policies+detail) | Isolates the structural topology for a native-verify checkpoint before the fiddly policy attachment |
