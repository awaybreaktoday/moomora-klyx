# M5-c-i: ClusterMesh Fleet Peering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cilium ClusterMesh peering visible on the fleet overview — a mesh strip above the cluster grid + a per-card mesh row — honestly showing *configured* peering (mutual vs asymmetric, off-fleet peers), never implying live connectivity.

**Architecture:** A new pure `internal/clustermesh` package parses `cilium-config` + the `cilium-clustermesh` Secret into per-cluster `Member`s and assembles a fleet `Graph` (peer matching by Cilium cluster-name). `capability` detects ClusterMesh-installed; `ClusterConn.MeshMember` does the live reads; a bound `MeshService` builds the graph on demand (mirrors `GatewayService`); the React fleet view renders the strip + per-card row. Snapshot, no watch.

**Tech Stack:** Go 1.26 + client-go v0.36 (typed + fakes), Wails v3, React 19 + TS 6 + Vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-06-klyx-clustermesh-design.md`. This is **M5-c-i** (fleet peering); M5-c-ii (topology global-service arrows) is a separate plan.

---

## Context the engineer needs

- **Real Secret shape (verified on homelab-blue):** `cilium-clustermesh` Secret has one `.data` key per remote cluster — the key IS the remote Cilium **cluster-name** (e.g. `homelab-orange`), value is a YAML config containing an `endpoints:` line. KVStoreMesh setups keep certs as file *paths inside* the value, so there are no top-level cert keys here — but other Cilium versions add `common-*`/`*.crt`/`*.key` keys, so the parser filters those defensively.
- **`cilium-config` ConfigMap:** `cluster-name` (e.g. `homelab-blue`), `cluster-id` (e.g. `1`, optional).
- **Fleet key vs Cilium name:** the fleet/kubeconfig key (`Snapshot.Name`, e.g. a context name) MAY differ from the Cilium `cluster-name`. **Peer matching is by Cilium cluster-name** (the Secret keys are Cilium names); display/click uses the fleet key.
- **Honesty:** render *configured* peering; mutual = both Secrets list each other, asymmetric = one-way; off-fleet peer = named by a cluster but not connected to Klyx. Never claim live `connected` health.
- **Existing wiring:** `fleet.Snapshot{Name, ..., Capabilities}`; `fleet.Conn` interface (add one method); `ClusterConn{typed kubernetes.Interface, caps capability.Set}`; `capability.NetworkCapability.ClusterMesh bool` (exists, unset); detector builds `NetworkCapability` in `detectNetwork`; appbridge `FleetService.GetFleet() []ClusterDTO`; main.go registers services via `application.NewService(...)`; frontend `useFleet` store (`clusters: ClusterDTO[]`), `FleetView.tsx` (the grid), `ClusterCard.tsx` (`<Stat label="network" .../>`).
- **On-demand pattern:** like `GatewayService.GetGatewayTopology` — a bound service method does live reads when the view asks, not in the periodic snapshot push.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/clustermesh/model.go` | `Identity`, `Member`, `MeshState`, `Graph`, `MeshNode`, `MeshEdge` | Create |
| `internal/clustermesh/parse.go` | `ParseIdentity`, `ParsePeers` | Create |
| `internal/clustermesh/graph.go` | `BuildGraph` | Create |
| `internal/clustermesh/*_test.go` | parse + graph tests | Create |
| `internal/clustermesh/testdata/` | real-shape Secret/ConfigMap fixtures | Create |
| `internal/capability/detector.go` | detect ClusterMesh-installed | Modify |
| `internal/capability/detector_test.go` | mesh-installed test | Modify |
| `internal/fleet/clustermesh.go` | `ClusterConn.MeshMember` | Create |
| `internal/fleet/conn.go` | `Conn` interface += `MeshMember` | Modify |
| `internal/fleet/clustermesh_test.go` | MeshMember fake test | Create |
| `internal/fleet/registry_test.go` | `fakeConn.MeshMember` stub | Modify |
| `internal/appbridge/mesh_service.go` | `MeshService` + `MeshConn` + DTOs + mapping | Create |
| `internal/appbridge/mesh_service_test.go` | DTO mapping tests | Create |
| `cmd/klyx/main.go` | construct + register `MeshService` | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | mesh DTO types + slice | Modify |
| `cmd/klyx/frontend/src/bridge/mesh.ts` | `getMeshGraph` | Create |
| `cmd/klyx/frontend/src/fleet/MeshStrip.tsx` | the mesh strip | Create |
| `cmd/klyx/frontend/src/fleet/FleetView.tsx` | mount strip + fetch | Modify |
| `cmd/klyx/frontend/src/fleet/ClusterCard.tsx` | per-card mesh row | Modify |
| `cmd/klyx/frontend/src/fleet/*.test.tsx` | strip + card tests | Create/Modify |

---

## Task 1: `clustermesh` model + parsers

**Files:**
- Create: `internal/clustermesh/model.go`, `internal/clustermesh/parse.go`, `internal/clustermesh/parse_test.go`, `internal/clustermesh/testdata/blue-clustermesh-secret.yaml`

- [ ] **Step 1: Create the real-shape fixture `internal/clustermesh/testdata/blue-clustermesh-secret.yaml`**

```yaml
# Shape captured from homelab-blue's cilium-clustermesh Secret (endpoints redacted).
# One key per remote cluster (key = remote Cilium cluster-name); value is a YAML
# etcd-client config with an "endpoints:" line. Plus a defensive cert key that the
# parser MUST ignore.
homelab-orange: |
  endpoints:
  - https://clustermesh-apiserver.kube-system.svc:2379
  trusted-ca-file: /var/lib/cilium/clustermesh/local-etcd-client-ca.crt
  key-file: /var/lib/cilium/clustermesh/local-etcd-client.key
  cert-file: /var/lib/cilium/clustermesh/local-etcd-client.crt
common-etcd-client-ca.crt: |
  -----BEGIN CERTIFICATE-----
  REDACTED
  -----END CERTIFICATE-----
```

- [ ] **Step 2: Write the failing test**

Create `internal/clustermesh/parse_test.go`:

```go
package clustermesh

import (
	"os"
	"path/filepath"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

func TestParseIdentity(t *testing.T) {
	id := ParseIdentity(&corev1.ConfigMap{Data: map[string]string{"cluster-name": "homelab-blue", "cluster-id": "1"}})
	if id.Name != "homelab-blue" || id.ID == nil || *id.ID != 1 {
		t.Fatalf("identity: %+v", id)
	}
	// Missing/malformed cluster-id still yields a usable identity by name.
	id2 := ParseIdentity(&corev1.ConfigMap{Data: map[string]string{"cluster-name": "x", "cluster-id": "oops"}})
	if id2.Name != "x" || id2.ID != nil {
		t.Fatalf("malformed id: %+v", id2)
	}
}

func TestParsePeersFixture(t *testing.T) {
	// Build a Secret whose StringData mirrors the real fixture (the cert key must be ignored).
	b, err := os.ReadFile(filepath.Join("testdata", "blue-clustermesh-secret.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]string
	if err := yaml.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	sec := &corev1.Secret{Data: map[string][]byte{}}
	for k, v := range raw {
		sec.Data[k] = []byte(v)
	}
	peers := ParsePeers(sec)
	if len(peers) != 1 || peers[0] != "homelab-orange" {
		t.Fatalf("peers: %+v (cert key must be filtered)", peers)
	}
}

func TestParsePeersFiltersAndNil(t *testing.T) {
	if ParsePeers(nil) != nil {
		t.Fatal("nil secret -> nil")
	}
	sec := &corev1.Secret{Data: map[string][]byte{
		"orange":                    []byte("endpoints:\n- https://x:2379\n"),
		"green.crt":                 []byte("endpoints:"), // dotted -> filtered even if value matches
		"common-etcd-client-ca.crt": []byte("cert"),       // internal -> filtered
		"weird":                     []byte("not-a-config"), // no endpoints: -> filtered
	}}
	peers := ParsePeers(sec)
	if len(peers) != 1 || peers[0] != "orange" {
		t.Fatalf("peers: %+v", peers)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `go test ./internal/clustermesh/ -run TestParse -v`
Expected: FAIL — package/`ParseIdentity`/`ParsePeers` undefined.

- [ ] **Step 4: Implement `internal/clustermesh/model.go`**

```go
// Package clustermesh parses Cilium ClusterMesh state (cilium-config + the
// cilium-clustermesh Secret) into per-cluster Members and assembles a fleet
// peering Graph. It renders CONFIGURED peering only - never live connectivity,
// which needs agent metrics (M7). Pure: no client-go dependency beyond the
// typed objects passed in.
package clustermesh

// MeshState is a cluster's mesh status (coarsest -> richest).
type MeshState string

const (
	MeshUnavailable MeshState = "unavailable" // ClusterMesh not installed
	MeshEnabled     MeshState = "enabled"     // installed, no configured peers
	MeshPeered      MeshState = "peered"      // >=1 configured peer, or named by another
)

// Identity is a cluster's Cilium identity. ID is optional display metadata; the
// graph identity is Name (the Cilium cluster-name).
type Identity struct {
	Name string
	ID   *int
}

// Member is one fleet cluster's mesh facts (fed to BuildGraph).
type Member struct {
	Cluster   string   // fleet key (kubeconfig context / Snapshot.Name)
	Identity  Identity // Cilium cluster-name / id
	Peers     []string // configured remote peer Cilium names (from the Secret)
	Present   bool     // connected to Klyx (always true for real fleet members)
	Installed bool     // ClusterMesh installed on this cluster
}

// MeshNode is a node in the fleet peering graph.
type MeshNode struct {
	Cluster   string    // fleet key (display + click target); "" for off-fleet peers
	Name      string    // Cilium cluster-name (display for off-fleet)
	ClusterID *int      // optional
	State     MeshState
	Present   bool      // false = off-fleet (named by a member, not connected to Klyx)
}

// MeshEdge is an undirected peering edge. Endpoints are fleet keys for present
// clusters, or the Cilium peer name for an off-fleet endpoint.
type MeshEdge struct {
	A, B   string
	Mutual bool // both sides configure each other; off-fleet edges are never mutual
}

type Graph struct {
	Nodes []MeshNode
	Edges []MeshEdge
}
```

- [ ] **Step 5: Implement `internal/clustermesh/parse.go`**

```go
package clustermesh

import (
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// ParseIdentity reads cluster-name + (optional) cluster-id from cilium-config.
func ParseIdentity(cm *corev1.ConfigMap) Identity {
	if cm == nil {
		return Identity{}
	}
	id := Identity{Name: strings.TrimSpace(cm.Data["cluster-name"])}
	if s, ok := cm.Data["cluster-id"]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			id.ID = &n
		}
	}
	return id
}

// ParsePeers returns the configured remote-cluster names from the
// cilium-clustermesh Secret. A key counts as a peer only when ALL hold:
//   - no dot (filters *.crt/*.key/*.pem and other file-like keys),
//   - not known-internal material (common-*),
//   - its value parses as a remote-cluster config (contains an "endpoints:" line).
// The value guard is the real decision - "no dot" alone is a first filter, so a
// future non-cert internal key cannot become a phantom peer.
func ParsePeers(sec *corev1.Secret) []string {
	if sec == nil {
		return nil
	}
	var peers []string
	for k, v := range sec.Data {
		if strings.Contains(k, ".") || strings.HasPrefix(k, "common-") {
			continue
		}
		if !strings.Contains(string(v), "endpoints:") {
			continue
		}
		peers = append(peers, k)
	}
	sort.Strings(peers)
	return peers
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/clustermesh/ -v` then `go vet ./internal/clustermesh/`
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/clustermesh/model.go internal/clustermesh/parse.go internal/clustermesh/parse_test.go internal/clustermesh/testdata/blue-clustermesh-secret.yaml
git commit -m "feat(clustermesh): model + ParseIdentity/ParsePeers (real-Secret fixture)"
```

---

## Task 2: `clustermesh.BuildGraph`

**Files:**
- Create: `internal/clustermesh/graph.go`, `internal/clustermesh/graph_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/clustermesh/graph_test.go`:

```go
package clustermesh

import (
	"sort"
	"testing"
)

func mem(fleetKey, ciliumName string, peers []string, installed bool) Member {
	return Member{Cluster: fleetKey, Identity: Identity{Name: ciliumName}, Peers: peers, Present: true, Installed: installed}
}

func findEdge(g Graph, a, b string) (MeshEdge, bool) {
	for _, e := range g.Edges {
		if (e.A == a && e.B == b) || (e.A == b && e.B == a) {
			return e, true
		}
	}
	return MeshEdge{}, false
}
func nodeState(g Graph, fleetKey string) MeshState {
	for _, n := range g.Nodes {
		if n.Cluster == fleetKey {
			return n.State
		}
	}
	return ""
}

func TestBuildGraphMutualAsymmetricStandalone(t *testing.T) {
	g := BuildGraph([]Member{
		mem("ctx-blue", "homelab-blue", []string{"homelab-orange"}, true),
		mem("ctx-orange", "homelab-orange", []string{"homelab-blue"}, true),
		mem("ctx-nelli", "homelab-nelli", nil, true), // installed, no peers
	})
	e, ok := findEdge(g, "ctx-blue", "ctx-orange")
	if !ok || !e.Mutual {
		t.Fatalf("blue<->orange should be a mutual edge: %+v", g.Edges)
	}
	if nodeState(g, "ctx-blue") != MeshPeered || nodeState(g, "ctx-nelli") != MeshEnabled {
		t.Fatalf("states: blue=%s nelli=%s", nodeState(g, "ctx-blue"), nodeState(g, "ctx-nelli"))
	}
	if len(g.Edges) != 1 {
		t.Fatalf("expected 1 edge, got %+v", g.Edges)
	}
}

func TestBuildGraphAsymmetric(t *testing.T) {
	// blue lists orange; orange does NOT list blue -> asymmetric.
	g := BuildGraph([]Member{
		mem("ctx-blue", "homelab-blue", []string{"homelab-orange"}, true),
		mem("ctx-orange", "homelab-orange", nil, true),
	})
	e, ok := findEdge(g, "ctx-blue", "ctx-orange")
	if !ok || e.Mutual {
		t.Fatalf("want asymmetric (non-mutual) edge: %+v", g.Edges)
	}
}

func TestBuildGraphIdentityNameDiffersFromFleetKey(t *testing.T) {
	// Fleet keys are kubeconfig contexts; peers are Cilium names. Matching MUST be by Cilium name.
	g := BuildGraph([]Member{
		mem("kubernetes-admin@homelab-blue", "homelab-blue", []string{"homelab-orange"}, true),
		mem("kubernetes-admin@homelab-orange", "homelab-orange", []string{"homelab-blue"}, true),
	})
	if _, ok := findEdge(g, "kubernetes-admin@homelab-blue", "kubernetes-admin@homelab-orange"); !ok {
		t.Fatalf("edge must resolve across differing fleet keys: %+v", g.Edges)
	}
}

func TestBuildGraphOffFleetPeerSelfDupUninstalled(t *testing.T) {
	g := BuildGraph([]Member{
		mem("ctx-blue", "homelab-blue", []string{"homelab-orange", "homelab-orange", "homelab-blue", "aks-prd-we"}, true),
	})
	// duplicate peer collapses; self-peer ignored; aks-prd-we is off-fleet.
	var offFleet []MeshNode
	for _, n := range g.Nodes {
		if !n.Present {
			offFleet = append(offFleet, n)
		}
	}
	if len(offFleet) != 1 || offFleet[0].Name != "aks-prd-we" {
		t.Fatalf("off-fleet node: %+v", offFleet)
	}
	// one edge to the off-fleet peer; no self edge.
	if e, ok := findEdge(g, "ctx-blue", "aks-prd-we"); !ok || e.Mutual {
		t.Fatalf("off-fleet edge (non-mutual): %+v", g.Edges)
	}
	for _, e := range g.Edges {
		if e.A == e.B {
			t.Fatalf("self edge present: %+v", e)
		}
	}
	// orange is named but not a fleet member -> off-fleet too; total off-fleet = orange + aks
	names := []string{}
	for _, n := range g.Nodes {
		if !n.Present {
			names = append(names, n.Name)
		}
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "aks-prd-we" || names[1] != "homelab-orange" {
		t.Fatalf("off-fleet names: %+v", names)
	}
}

func TestBuildGraphUninstalled(t *testing.T) {
	g := BuildGraph([]Member{mem("ctx-x", "x", nil, false)})
	if nodeState(g, "ctx-x") != MeshUnavailable {
		t.Fatalf("uninstalled -> unavailable: %s", nodeState(g, "ctx-x"))
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/clustermesh/ -run TestBuildGraph -v`
Expected: FAIL — `BuildGraph` undefined.

- [ ] **Step 3: Implement `internal/clustermesh/graph.go`**

```go
package clustermesh

import "sort"

// BuildGraph assembles the fleet peering graph from per-cluster Members. Peer
// matching is by Cilium cluster-name (Member.Identity.Name, falling back to the
// fleet key). A peer not present in the fleet becomes an off-fleet node
// (Present=false). Mutual = both sides configure each other; off-fleet edges are
// never mutual (we can't read the other side).
func BuildGraph(members []Member) Graph {
	// Index fleet members by their Cilium name (fallback fleet key) for resolution.
	byName := make(map[string]*Member, len(members))
	for i := range members {
		m := &members[i]
		byName[nameKey(m)] = m
	}

	g := Graph{}
	// Fleet nodes.
	for i := range members {
		m := &members[i]
		g.Nodes = append(g.Nodes, MeshNode{
			Cluster: m.Cluster, Name: m.Identity.Name, ClusterID: m.Identity.ID,
			State: stateOf(m, members), Present: true,
		})
	}

	// Edges + off-fleet nodes.
	type pk struct{ a, b string }
	edgeAt := map[pk]int{} // canonical pair -> index in g.Edges
	offFleet := map[string]bool{}

	for i := range members {
		m := &members[i]
		self := nameKey(m)
		for _, peer := range dedup(m.Peers) {
			if peer == self || peer == m.Identity.Name {
				continue // ignore a cluster naming itself
			}
			var endpoint string
			var mutual bool
			if other, ok := byName[peer]; ok {
				endpoint = other.Cluster
				mutual = lists(other, m) // other configures us back
			} else {
				endpoint = peer // off-fleet endpoint keyed by Cilium name
				if !offFleet[peer] {
					offFleet[peer] = true
					g.Nodes = append(g.Nodes, MeshNode{Name: peer, State: MeshPeered, Present: false})
				}
			}
			a, b := m.Cluster, endpoint
			if a > b {
				a, b = b, a
			}
			key := pk{a, b}
			if idx, ok := edgeAt[key]; ok {
				if mutual {
					g.Edges[idx].Mutual = true
				}
				continue
			}
			edgeAt[key] = len(g.Edges)
			g.Edges = append(g.Edges, MeshEdge{A: a, B: b, Mutual: mutual})
		}
	}
	return g
}

func nameKey(m *Member) string {
	if m.Identity.Name != "" {
		return m.Identity.Name
	}
	return m.Cluster
}

// lists reports whether other configures m as a peer (by m's Cilium name).
func lists(other, m *Member) bool {
	target := m.Identity.Name
	if target == "" {
		target = m.Cluster
	}
	for _, p := range other.Peers {
		if p == target {
			return true
		}
	}
	return false
}

func stateOf(m *Member, all []Member) MeshState {
	if !m.Installed {
		return MeshUnavailable
	}
	if len(m.Peers) > 0 {
		return MeshPeered
	}
	for i := range all {
		if &all[i] == m {
			continue
		}
		if lists(&all[i], m) {
			return MeshPeered
		}
	}
	return MeshEnabled
}

func dedup(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/clustermesh/ -v` then `go vet ./internal/clustermesh/`
Expected: PASS (all clustermesh tests), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/clustermesh/graph.go internal/clustermesh/graph_test.go
git commit -m "feat(clustermesh): BuildGraph (peer-by-cilium-name, mutual/asymmetric/off-fleet)"
```

---

## Task 3: capability — detect ClusterMesh installed

**Files:**
- Modify: `internal/capability/detector.go`, `internal/capability/detector_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/capability/detector_test.go` (reuse the package's existing fake-clientset helpers; if the test file builds a `*fake.Clientset`, follow that pattern):

```go
func TestDetectClusterMeshInstalled(t *testing.T) {
	// clustermesh-apiserver Deployment present -> ClusterMesh true.
	cs := fake.NewSimpleClientset(&appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "clustermesh-apiserver", Namespace: "kube-system"},
	})
	d := NewDetector(cs)
	if !d.clusterMeshInstalled(context.Background()) {
		t.Fatal("clustermesh-apiserver deployment should mark ClusterMesh installed")
	}
	// Nothing present -> false.
	if NewDetector(fake.NewSimpleClientset()).clusterMeshInstalled(context.Background()) {
		t.Fatal("no apiserver/secret -> not installed")
	}
}
```

Add imports as needed (`appsv1 "k8s.io/api/apps/v1"`, `metav1`, `context`, the fake clientset) — match the existing test file's imports.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/capability/ -run TestDetectClusterMesh -v`
Expected: FAIL — `clusterMeshInstalled` undefined.

- [ ] **Step 3: Implement in `internal/capability/detector.go`**

Add the helper (uses the existing `d.cs` typed client) and call it from `detectNetwork`:

```go
// clusterMeshInstalled reports whether Cilium ClusterMesh is installed: the
// clustermesh-apiserver Deployment OR the cilium-clustermesh Secret in kube-system.
func (d *Detector) clusterMeshInstalled(ctx context.Context) bool {
	if _, err := d.cs.AppsV1().Deployments("kube-system").Get(ctx, "clustermesh-apiserver", metav1.GetOptions{}); err == nil {
		return true
	}
	if _, err := d.cs.CoreV1().Secrets("kube-system").Get(ctx, "cilium-clustermesh", metav1.GetOptions{}); err == nil {
		return true
	}
	return false
}
```

In `detectNetwork`, after `out.CiliumPresent = served["cilium.io"]`, add:

```go
	out.CiliumPresent = served["cilium.io"]
	if out.CiliumPresent {
		out.ClusterMesh = d.clusterMeshInstalled(ctx)
	}
```

(Only probe when Cilium is present — no point hitting kube-system on a non-Cilium cluster.) Confirm `detectNetwork`'s signature has `ctx` available (it is `detectNetwork(ctx context.Context, served map[string]bool)`).

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/capability/ -v` then `go vet ./internal/capability/`
Expected: PASS (existing capability tests still pass — the probe only runs when Cilium is served, and existing tests either don't serve cilium.io or tolerate the extra Get), vet clean.

- [ ] **Step 5: Commit**

```bash
git add internal/capability/detector.go internal/capability/detector_test.go
git commit -m "feat(capability): detect ClusterMesh installed (apiserver/secret)"
```

---

## Task 4: `ClusterConn.MeshMember`

**Files:**
- Create: `internal/fleet/clustermesh.go`, `internal/fleet/clustermesh_test.go`
- Modify: `internal/fleet/conn.go` (`Conn` interface), `internal/fleet/registry_test.go` (`fakeConn`)

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/clustermesh_test.go`:

```go
package fleet

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
)

func TestMeshMember(t *testing.T) {
	cfg := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cilium-config", Namespace: "kube-system"},
		Data: map[string]string{"cluster-name": "homelab-blue", "cluster-id": "1"}}
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "cilium-clustermesh", Namespace: "kube-system"},
		Data: map[string][]byte{"homelab-orange": []byte("endpoints:\n- https://x:2379\n")}}
	apiserver := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "clustermesh-apiserver", Namespace: "kube-system"}}
	typed := typedfake.NewSimpleClientset(cfg, sec, apiserver)

	c := NewClusterConn("ctx-blue", typed, nil, nil, nil, clock.Real{})
	m, st := c.MeshMember(context.Background())
	if m.Cluster != "ctx-blue" || m.Identity.Name != "homelab-blue" || m.Identity.ID == nil || *m.Identity.ID != 1 {
		t.Fatalf("identity: %+v", m)
	}
	if len(m.Peers) != 1 || m.Peers[0] != "homelab-orange" || !m.Present || !m.Installed {
		t.Fatalf("member: %+v", m)
	}
	if !st.ClusterMeshInstalled || !st.IdentityRead || !st.PeersRead {
		t.Fatalf("status: %+v", st)
	}
}

func TestMeshMemberStandalone(t *testing.T) {
	// No clustermesh secret/apiserver: still returns a usable member (so the cluster stays a fleet node).
	cfg := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cilium-config", Namespace: "kube-system"},
		Data: map[string]string{"cluster-name": "homelab-nelli"}}
	typed := typedfake.NewSimpleClientset(cfg)
	c := NewClusterConn("ctx-nelli", typed, nil, nil, nil, clock.Real{})
	m, st := c.MeshMember(context.Background())
	if m.Cluster != "ctx-nelli" || m.Identity.Name != "homelab-nelli" || len(m.Peers) != 0 || m.Installed {
		t.Fatalf("standalone member: %+v", m)
	}
	if st.ClusterMeshInstalled {
		t.Fatalf("status installed should be false: %+v", st)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestMeshMember -v`
Expected: FAIL — `c.MeshMember` undefined.

- [ ] **Step 3: Implement `internal/fleet/clustermesh.go`**

```go
package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/moomora/klyx/internal/clustermesh"
)

// MeshReadStatus records what the mesh read could and couldn't see (nuance the
// returned Member alone can't carry).
type MeshReadStatus struct {
	ClusterMeshInstalled bool
	IdentityRead         bool
	PeersRead            bool
	Note                 string
}

// MeshMember reads this cluster's Cilium mesh facts (cilium-config + the
// cilium-clustermesh Secret). It ALWAYS returns a usable Member (Present=true)
// even when the Secret is absent, so a standalone cluster still becomes a fleet
// node. Installed is detected via the clustermesh-apiserver Deployment / Secret.
func (c *ClusterConn) MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus) {
	m := clustermesh.Member{Cluster: c.name, Present: true}
	var st MeshReadStatus

	if cm, err := c.typed.CoreV1().ConfigMaps("kube-system").Get(ctx, "cilium-config", metav1.GetOptions{}); err == nil {
		m.Identity = clustermesh.ParseIdentity(cm)
		st.IdentityRead = true
	}
	if sec, err := c.typed.CoreV1().Secrets("kube-system").Get(ctx, "cilium-clustermesh", metav1.GetOptions{}); err == nil {
		m.Peers = clustermesh.ParsePeers(sec)
		st.PeersRead = true
		st.ClusterMeshInstalled = true
	} else if _, derr := c.typed.AppsV1().Deployments("kube-system").Get(ctx, "clustermesh-apiserver", metav1.GetOptions{}); derr == nil {
		st.ClusterMeshInstalled = true
	}
	m.Installed = st.ClusterMeshInstalled
	return m, st
}
```

- [ ] **Step 4: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add to the `Conn` interface (after `GetGatewayTopology`) + add the `clustermesh` import:

```go
	GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error)
	MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus)
```

- [ ] **Step 5: Add `fakeConn` stub**

In `internal/fleet/registry_test.go`, after the `GetGatewayTopology` stub (+ add the `clustermesh` import):

```go
func (f *fakeConn) MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus) {
	return clustermesh.Member{Cluster: f.name, Present: true}, MeshReadStatus{}
}
```

(If `fakeConn` has no `name` field, use a literal like `"fake"` — match the struct.)

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run TestMeshMember -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/clustermesh.go internal/fleet/clustermesh_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.MeshMember (config+secret read, always returns a member)"
```

---

## Task 5: appbridge `MeshService` + register

**Files:**
- Create: `internal/appbridge/mesh_service.go`, `internal/appbridge/mesh_service_test.go`
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Write the failing test**

Create `internal/appbridge/mesh_service_test.go`:

```go
package appbridge

import (
	"testing"

	"github.com/moomora/klyx/internal/clustermesh"
)

func TestMeshServiceGraph(t *testing.T) {
	members := []clustermesh.Member{
		{Cluster: "ctx-blue", Identity: clustermesh.Identity{Name: "homelab-blue"}, Peers: []string{"homelab-orange"}, Present: true, Installed: true},
		{Cluster: "ctx-orange", Identity: clustermesh.Identity{Name: "homelab-orange"}, Peers: []string{"homelab-blue"}, Present: true, Installed: true},
		{Cluster: "ctx-nelli", Identity: clustermesh.Identity{Name: "homelab-nelli"}, Present: true, Installed: true},
	}
	svc := NewMeshService(func() []clustermesh.Member { return members })
	g := svc.GetMeshGraph()

	if len(g.Nodes) != 3 {
		t.Fatalf("nodes: %+v", g.Nodes)
	}
	var mutual bool
	for _, e := range g.Edges {
		if (e.A == "ctx-blue" && e.B == "ctx-orange") || (e.A == "ctx-orange" && e.B == "ctx-blue") {
			mutual = e.Mutual
		}
	}
	if len(g.Edges) != 1 || !mutual {
		t.Fatalf("edges: %+v", g.Edges)
	}
	// nelli state mapped through.
	for _, n := range g.Nodes {
		if n.Cluster == "ctx-nelli" && n.State != "enabled" {
			t.Fatalf("nelli state: %s", n.State)
		}
	}
}

func TestMeshServiceEmpty(t *testing.T) {
	svc := NewMeshService(func() []clustermesh.Member { return nil })
	g := svc.GetMeshGraph()
	if len(g.Nodes) != 0 || len(g.Edges) != 0 {
		t.Fatalf("empty: %+v", g)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestMeshService -v`
Expected: FAIL — `NewMeshService` undefined.

- [ ] **Step 3: Implement `internal/appbridge/mesh_service.go`**

```go
package appbridge

import "github.com/moomora/klyx/internal/clustermesh"

type MeshNodeDTO struct {
	Cluster   string `json:"cluster"`
	Name      string `json:"name"`
	ClusterID *int   `json:"clusterId"`
	State     string `json:"state"`
	Present   bool   `json:"present"`
}
type MeshEdgeDTO struct {
	A      string `json:"a"`
	B      string `json:"b"`
	Mutual bool   `json:"mutual"`
}
type MeshGraphDTO struct {
	Nodes []MeshNodeDTO `json:"nodes"`
	Edges []MeshEdgeDTO `json:"edges"`
}

// MeshService builds the fleet ClusterMesh graph on demand. listMembers does the
// live per-cluster reads (wired in main.go from the registry).
type MeshService struct {
	listMembers func() []clustermesh.Member
}

func NewMeshService(listMembers func() []clustermesh.Member) *MeshService {
	return &MeshService{listMembers: listMembers}
}

func (s *MeshService) GetMeshGraph() MeshGraphDTO {
	g := clustermesh.BuildGraph(s.listMembers())
	out := MeshGraphDTO{Nodes: make([]MeshNodeDTO, 0, len(g.Nodes)), Edges: make([]MeshEdgeDTO, 0, len(g.Edges))}
	for _, n := range g.Nodes {
		out.Nodes = append(out.Nodes, MeshNodeDTO{Cluster: n.Cluster, Name: n.Name, ClusterID: n.ClusterID, State: string(n.State), Present: n.Present})
	}
	for _, e := range g.Edges {
		out.Edges = append(out.Edges, MeshEdgeDTO{A: e.A, B: e.B, Mutual: e.Mutual})
	}
	return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/appbridge/ -v` then `go vet ./internal/appbridge/`
Expected: PASS, vet clean.

- [ ] **Step 5: Register in `cmd/klyx/main.go`**

After the `gatewaySvc := ...` block, add a mesh service whose provider iterates the registry (snapshot names → conn → `MeshMember`), with a bounded context:

```go
	meshSvc := appbridge.NewMeshService(func() []clustermesh.Member {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var members []clustermesh.Member
		for _, snap := range reg.Snapshots() {
			c, ok := reg.Conn(snap.Name)
			if !ok {
				continue
			}
			m, _ := c.MeshMember(ctx)
			members = append(members, m)
		}
		return members
	})
```

Add to the `Services:` slice: `application.NewService(meshSvc),`. Add imports for `context`, `time` (likely already present) and `github.com/moomora/klyx/internal/clustermesh`.

- [ ] **Step 6: Build to verify it compiles**

Run: `go build ./cmd/klyx/ 2>&1 | grep -vE "ld: warning|object file" | tail`
Expected: builds clean (the registry's `Conn` returns `fleet.Conn`, which now has `MeshMember`).

- [ ] **Step 7: Commit**

```bash
rm -f klyx
git add internal/appbridge/mesh_service.go internal/appbridge/mesh_service_test.go cmd/klyx/main.go
git commit -m "feat(appbridge): MeshService + GetMeshGraph; register with the Wails app"
```

---

## Task 6: frontend store + bridge + `MeshStrip`

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Create: `cmd/klyx/frontend/src/bridge/mesh.ts`, `cmd/klyx/frontend/src/fleet/MeshStrip.tsx`, `cmd/klyx/frontend/src/fleet/MeshStrip.test.tsx`
- Modify: `cmd/klyx/frontend/src/fleet/FleetView.tsx`

- [ ] **Step 1: Add store types + slice in `cmd/klyx/frontend/src/store/fleet.ts`**

Add near the DTO types:

```ts
export type MeshNodeDTO = { cluster: string; name: string; clusterId: number | null; state: string; present: boolean };
export type MeshEdgeDTO = { a: string; b: string; mutual: boolean };
export type MeshGraphDTO = { nodes: MeshNodeDTO[]; edges: MeshEdgeDTO[] };
```

Add to `FleetState` (the type) + the store body:

```ts
  mesh: MeshGraphDTO | null;
  setMesh: (m: MeshGraphDTO) => void;
```

In the store body (near `setClusters`):

```ts
  mesh: null,
  setMesh: (mesh) => set({ mesh }),
```

- [ ] **Step 2: Create `cmd/klyx/frontend/src/bridge/mesh.ts`**

```ts
import { useFleet, MeshGraphDTO } from "../store/fleet";
import { MeshService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function getMeshGraph(): Promise<void> {
  const g = (await MeshService.GetMeshGraph()) as MeshGraphDTO;
  useFleet.getState().setMesh(g ?? { nodes: [], edges: [] });
}
```

NOTE: `MeshService` resolves only after bindings are regenerated (Task 8). Do NOT run tsc here.

- [ ] **Step 3: Write the failing `MeshStrip` test**

Create `cmd/klyx/frontend/src/fleet/MeshStrip.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MeshStrip } from "./MeshStrip";
import type { MeshGraphDTO } from "../store/fleet";

const graph: MeshGraphDTO = {
  nodes: [
    { cluster: "ctx-blue", name: "homelab-blue", clusterId: 1, state: "peered", present: true },
    { cluster: "ctx-orange", name: "homelab-orange", clusterId: 2, state: "peered", present: true },
    { cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true },
    { cluster: "", name: "aks-prd-we", clusterId: null, state: "peered", present: false },
  ],
  edges: [
    { a: "ctx-blue", b: "ctx-orange", mutual: true },
    { a: "ctx-blue", b: "aks-prd-we", mutual: false },
  ],
};

describe("MeshStrip", () => {
  it("renders nothing when no node is mesh-capable", () => {
    const { container } = render(<MeshStrip graph={{ nodes: [{ cluster: "x", name: "x", clusterId: null, state: "unavailable", present: true }], edges: [] }} />);
    expect(container.textContent).toBe("");
  });

  it("renders the strip with cluster names, the configured-peering caption, and an off-fleet node", () => {
    const { getByText } = render(<MeshStrip graph={graph} />);
    expect(getByText(/CLUSTER-?MESH/i)).toBeTruthy();
    expect(getByText(/configured peering \(not live connectivity\)/i)).toBeTruthy();
    expect(getByText("homelab-blue")).toBeTruthy();
    expect(getByText("aks-prd-we")).toBeTruthy(); // off-fleet node shown
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/MeshStrip.test.tsx`
Expected: FAIL — cannot find `./MeshStrip`.

- [ ] **Step 5: Implement `cmd/klyx/frontend/src/fleet/MeshStrip.tsx`**

```tsx
import type { MeshGraphDTO } from "../store/fleet";

const node: React.CSSProperties = {
  background: "var(--color-background-primary)", border: "1px solid var(--color-border-info)",
  borderRadius: 7, padding: "5px 10px", fontFamily: "var(--font-mono)", fontSize: 11,
};

export function MeshStrip({ graph }: { graph: MeshGraphDTO }) {
  // Render only when at least one cluster has ClusterMesh installed.
  const meshy = graph.nodes.some((n) => n.state !== "unavailable");
  if (!meshy) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--color-text-tertiary)" }}>clustermesh</span>
        <span style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>configured peering (not live connectivity)</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "12px 14px" }}>
        {graph.nodes.map((n) => {
          const standalone = n.state === "enabled";
          const off = !n.present;
          return (
            <span
              key={n.cluster || n.name}
              style={{
                ...node,
                borderColor: off || standalone ? "var(--color-border-tertiary)" : "var(--color-border-info)",
                color: off ? "var(--color-text-tertiary)" : standalone ? "var(--color-text-secondary)" : "var(--color-text-primary)",
                opacity: off ? 0.6 : 1,
              }}
              title={off ? "off-fleet peer (not connected to Klyx)" : standalone ? "mesh enabled, no peers" : "meshed"}
            >
              {n.name}{standalone ? " ⬡" : ""}{off ? " (off-fleet)" : ""}
            </span>
          );
        })}
      </div>
      {graph.edges.some((e) => !e.mutual) && (
        <div style={{ fontSize: 9, color: "var(--color-text-warning)", marginTop: 4 }}>⚠ dashed = asymmetric / off-fleet (one-way configured)</div>
      )}
    </div>
  );
}
```

NOTE: this v1 renders nodes + an asymmetry caption (edges are conveyed via the per-card row + the caption). A literal line-drawing layout is intentionally deferred (decision #5: a strip that scales beats tangled lines).

- [ ] **Step 6: Mount it in `cmd/klyx/frontend/src/fleet/FleetView.tsx`**

Add imports:

```tsx
import { useEffect } from "react";
import { MeshStrip } from "./MeshStrip";
import { getMeshGraph } from "../bridge/mesh";
```

Read `mesh` from the store, fetch on mount, render the strip above the card grid. Add near the top of the `FleetView` component body:

```tsx
  const mesh = useFleet((s) => s.mesh);
  useEffect(() => {
    getMeshGraph().catch((e) => console.error("getMeshGraph", e));
  }, []);
```

And immediately before the cluster-card grid element, render:

```tsx
      {mesh && <MeshStrip graph={mesh} />}
```

(Match the real `FleetView` selector/JSX names; the grid is the element mapping `clusters`.)

- [ ] **Step 7: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/MeshStrip.test.tsx` then `npx vitest run src/fleet/`
Expected: PASS (MeshStrip + no FleetView regressions). Do NOT run tsc (bindings come in Task 8).

- [ ] **Step 8: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/bridge/mesh.ts cmd/klyx/frontend/src/fleet/MeshStrip.tsx cmd/klyx/frontend/src/fleet/MeshStrip.test.tsx cmd/klyx/frontend/src/fleet/FleetView.tsx
git commit -m "feat(ui): mesh slice + getMeshGraph bridge + MeshStrip above the fleet grid"
```

---

## Task 7: per-card mesh row

**Files:**
- Modify: `cmd/klyx/frontend/src/fleet/ClusterCard.tsx`, `cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx` (the card takes a `ClusterDTO` `c`; it now also reads the mesh graph from the store — seed it via `useFleet.setState`):

```tsx
import { useFleet } from "../store/fleet";

it("shows the mesh row from the graph: peered / asymmetric / standalone / off-fleet", () => {
  useFleet.setState({ mesh: {
    nodes: [
      { cluster: "ctx-blue", name: "homelab-blue", clusterId: 1, state: "peered", present: true },
      { cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true },
    ],
    edges: [{ a: "ctx-blue", b: "ctx-orange", mutual: true }],
  }});
  // a peered cluster shows its peer
  const blue = { name: "ctx-blue", state: "Ready", networkTier: "Healthy" } as any;
  const { getByText } = render(<ClusterCard c={blue} />);
  expect(getByText(/mesh:/i)).toBeTruthy();
  expect(getByText(/ctx-orange/)).toBeTruthy();
});

it("shows 'mesh enabled, no peers' for an installed-but-peerless cluster", () => {
  useFleet.setState({ mesh: {
    nodes: [{ cluster: "ctx-nelli", name: "homelab-nelli", clusterId: null, state: "enabled", present: true }],
    edges: [],
  }});
  const nelli = { name: "ctx-nelli", state: "Ready", networkTier: "Healthy" } as any;
  const { getByText } = render(<ClusterCard c={nelli} />);
  expect(getByText(/mesh enabled, no peers/i)).toBeTruthy();
});
```

(Match the real `ClusterCard` prop name/shape — it renders `c.networkTier` etc.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/ClusterCard.test.tsx -t "mesh"`
Expected: FAIL — no mesh row.

- [ ] **Step 3: Implement the mesh row in `cmd/klyx/frontend/src/fleet/ClusterCard.tsx`**

Add a helper that derives a card's mesh row from the store graph, and render it after the existing `<Stat label="network" .../>` row. Add imports (`useFleet`, the mesh types) at the top.

```tsx
import { useFleet, MeshGraphDTO } from "../store/fleet";

function meshRow(graph: MeshGraphDTO | null, cluster: string): string | null {
  if (!graph) return null;
  const node = graph.nodes.find((n) => n.cluster === cluster);
  if (!node || node.state === "unavailable") return "⬡ no ClusterMesh";
  if (node.state === "enabled") return "⬡ mesh enabled, no peers";
  // peered: collect peers from edges touching this cluster.
  const peers: string[] = [];
  let asym = false;
  let offFleet = 0;
  for (const e of graph.edges) {
    const other = e.a === cluster ? e.b : e.b === cluster ? e.a : null;
    if (!other) continue;
    const on = graph.nodes.find((n) => (n.cluster || n.name) === other);
    if (on && !on.present) { offFleet++; continue; }
    peers.push(other);
    if (!e.mutual) asym = true;
  }
  let row = `⇄ mesh: ${peers.join(", ") || "—"}`;
  if (asym) row += " (asymmetric)";
  if (offFleet > 0) row += ` (+${offFleet} off-fleet)`;
  return row;
}
```

Hoist the store read to the TOP of the `ClusterCard` component body (hooks must not be called inside
an IIFE/conditionally):

```tsx
  const mesh = useFleet((s) => s.mesh);
  const row = meshRow(mesh, c.name);
```

Then, in the card body after the network `<Stat>`, render the row:

```tsx
        {row && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>{row}</div>}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/fleet/ClusterCard.test.tsx` then `npx vitest run`
Expected: PASS (whole suite green).

- [ ] **Step 5: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/fleet/ClusterCard.tsx cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx
git commit -m "feat(ui): per-card mesh row (peered/asymmetric/off-fleet/enabled/none)"
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
grep -rn "GetMeshGraph" frontend/bindings/github.com/moomora/klyx/internal/appbridge/ | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show `GetMeshGraph` + the `Mesh*DTO` models; vitest green; **tsc clean** (the new mesh types + `bridge/mesh.ts` + `MeshStrip`/`ClusterCard` compile against the regenerated `MeshService`); build exit 0 (ignore `ld: warning` + the known ios scaffold). If tsc errors, read + fix the source, re-run.

NOTE: `cmd/klyx/frontend/bindings/` is gitignored — nothing to commit from binding regen.

- [ ] **Step 3: Clean up build output, confirm clean tree**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
rm -f klyx cmd/klyx/bin/klyx 2>/dev/null; git status --short
```
Expected: clean tree.

- [ ] **Step 4: Native handoff (owner, homelab fleet)**

With Klyx connected to homelab-blue, homelab-orange, homelab-nelli, open the **Fleet** view:
- The **mesh strip** appears above the cluster grid with `homelab-blue` and `homelab-orange` as peered nodes and `homelab-nelli ⬡` muted (mesh enabled / standalone). Caption reads "configured peering (not live connectivity)".
- Each **card's mesh row**: blue → `⇄ mesh: <orange's fleet key>`; orange → `⇄ mesh: <blue's fleet key>`; nelli → `⬡ mesh enabled, no peers` (or `⬡ no ClusterMesh` if Cilium ClusterMesh isn't installed there).
- If the fleet display key differs from the Cilium cluster-name, the edge still resolves (peer matching by Cilium name) — confirm blue↔orange still connect.
- No merge here — gate on native verification, then `finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage (M5-c-i portion):** §1 detection (`ParseIdentity`/`ParsePeers`/`BuildGraph`, MeshState, peer-by-cilium-name, optional cluster-id) → T1/T2. §2 capability (installed) → T3. §3 fleet `MeshMember` (always returns a member, read status) → T4. §4 DTO (`MeshGraphDTO` nodes/edges) → T5. §5 fleet UI (strip + per-card row, all five row states, off-fleet dimmed, "configured peering" caption) → T6/T7. §7 testing → each task; native handoff → T8. (§6 topology arrows = M5-c-ii, separate plan.)
- **Honesty:** the strip caption + per-card states render *configured* peering only; mutual vs asymmetric via `MeshEdge.Mutual`; off-fleet peers shown dimmed and never implied as reachable. No live-connectivity claim anywhere.
- **The floorboards bug:** `BuildGraph` matches peers by `Identity.Name` (Cilium cluster-name), tested by `TestBuildGraphIdentityNameDiffersFromFleetKey`.
- **Type consistency:** Go `clustermesh.{Member,Graph,MeshNode,MeshEdge,MeshState}` → DTO `Mesh{Node,Edge,Graph}DTO` (json `cluster,name,clusterId,state,present` / `a,b,mutual`) → TS `Mesh{Node,Edge,Graph}DTO`. `MeshMember` identical across `Conn`, `ClusterConn`, `fakeConn`. `GetMeshGraph` is the single bound method.
- **On-demand:** `MeshService` mirrors `GatewayService` (a `listMembers` provider, live reads in main.go's closure) — no change to the periodic snapshot push; the fleet view fetches on mount.
- **`ServiceNode`/topology untouched:** M5-c-i adds nothing to the gateway topology; the `⇄ global →` pods-box edge is M5-c-ii.
