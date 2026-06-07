# M5-c-ii: ClusterMesh Topology Arrows (global services) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a route's backend is a Cilium **global service** (`service.cilium.io/global: "true"`), show a cross-cluster `⇄ global → <peer>` edge on the pods box listing the **fleet-confirmed** peer clusters that also host that same global service — replacing the last "ClusterMesh: not shown yet" placeholder.

**Architecture:** `gwapi.ServiceNode` gains a local `Global` flag (set in `resolveBackends` from the Service annotation — a single-cluster fact). The cross-cluster confirmation is **DTO-only orchestration**: `GatewayService.GetGatewayTopology` enriches each global `ServiceNodeDTO` with `meshClusters`/`meshUnconfirmed` via a `globalReach` provider wired in main.go (it reads the cluster's mesh peers, resolves them to fleet members by Cilium cluster-name, and asks each present peer `HasGlobalService`). Honest: confirms *configured global-service presence on a fleet peer*, never live dataplane reach.

**Tech Stack:** Go 1.26 + client-go v0.36 (typed + fakes), Wails v3, React 19 + TS 6 + Vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-06-klyx-clustermesh-design.md` (§6 + decisions #6/#8). This is **M5-c-ii**; M5-c-i (fleet peering) shipped.

---

## Context the engineer needs

- **Global service signal:** a Cilium global service carries the annotation `service.cilium.io/global: "true"` on the `Service`. The same global service is matched across the mesh by **namespace + name**.
- **`resolveBackends`** (`internal/fleet/gateway.go`) already typed-`Get`s each backend Service (it sets `sn.Type`, `sn.Selector`). Add `sn.Global = svc.Annotations["service.cilium.io/global"] == "true"` there.
- **`gwapi.ServiceNode`** carries single-cluster facts only. `Global` belongs there; `MeshClusters`/`MeshUnconfirmed` do NOT (they need fleet access the single-cluster topology lacks) — they live on the **DTO** and are filled by the appbridge orchestration. Keeps `gwapi` pure/single-cluster.
- **Honesty (decision #6):** `meshClusters` = fleet-present peers that host a same-`ns/name` global Service AND share a mesh edge. A peer named in the mesh but NOT connected to Klyx (off-fleet) is **never** in `meshClusters` — it only sets `meshUnconfirmed=true`.
- **Cross-reference orchestration:** `GatewayService` gets an optional `globalReach func(cluster, ns, name string) (peers []string, unconfirmed bool)`. main.go wires it from the registry: cluster A's `MeshMember` → peer Cilium names; resolve each to a fleet member (by matching that member's `MeshMember().Identity.Name`); a present peer → `peerConn.HasGlobalService(ns, name)`; an unresolved (off-fleet) peer → `unconfirmed=true`. `peers` are the peer **fleet keys** (display).
- **`MeshMember`** (M5-c-i, on `fleet.Conn`) returns `(clustermesh.Member, MeshReadStatus)`; `Member.Identity.Name` is the Cilium cluster-name, `Member.Peers` the configured peer Cilium names, `Member.Cluster` the fleet key.
- **Frontend:** the pods box (already hosts inferred CNP chips) gets the `⇄ global →` edge; the `⬡ ClusterMesh: not shown yet …` placeholder line is replaced.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gwapi/model.go` | `ServiceNode.Global` field | Modify |
| `internal/fleet/gateway.go` | set `sn.Global` in `resolveBackends` | Modify |
| `internal/fleet/gateway_test.go` | global-annotation test | Modify |
| `internal/fleet/clustermesh.go` | `ClusterConn.HasGlobalService` | Modify |
| `internal/fleet/conn.go` | `Conn` interface += `HasGlobalService` | Modify |
| `internal/fleet/clustermesh_test.go` | HasGlobalService test | Modify |
| `internal/fleet/registry_test.go` | `fakeConn.HasGlobalService` stub | Modify |
| `internal/appbridge/gateway_dto.go` | `ServiceNodeDTO` global/meshClusters/meshUnconfirmed + mapping | Modify |
| `internal/appbridge/gateway_service.go` | `globalReach` provider + enrich global services | Modify |
| `internal/appbridge/gateway_service_test.go` | enrich test | Modify |
| `cmd/klyx/main.go` | wire `globalReach` from the registry | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | `ServiceNodeDTO` global/meshClusters/meshUnconfirmed | Modify |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx` | pods-box `⇄ global →` edge; replace placeholder | Modify |
| `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` | global-edge test | Modify |

---

## Task 1: `ServiceNode.Global` + detect in `resolveBackends`

**Files:**
- Modify: `internal/gwapi/model.go`, `internal/fleet/gateway.go`, `internal/fleet/gateway_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/fleet/gateway_test.go` a test that a backend Service annotated global sets `ServiceNode.Global`. Reuse the existing `seedGW`/`gw`/`hr` helpers + a typed Service with the annotation:

```go
func TestGetGatewayTopologyGlobalService(t *testing.T) {
	dyn := seedGW(t, map[schema.GroupVersionResource][]*unstructured.Unstructured{
		gwGVR(): {gw("eg", "infra")},
		hrGVR(): {hr("share", "apps", "eg", "infra", "share-api")},
	})
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps", Annotations: map[string]string{"service.cilium.io/global": "true"}},
		Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Ports: []corev1.ServicePort{{Port: 80}}},
	}
	typed := typedfake.NewSimpleClientset(svc)
	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	topo, err := c.GetGatewayTopology(context.Background(), "infra", "eg")
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	if len(topo.Routes) != 1 || len(topo.Routes[0].Services) != 1 || !topo.Routes[0].Services[0].Global {
		t.Fatalf("service should be marked global: %+v", topo.Routes[0].Services)
	}
}
```

(If `corev1`/`metav1`/`typedfake` aren't imported in this test file yet, they are — the M5-a/M5-b fleet tests use them.)

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestGetGatewayTopologyGlobalService -v`
Expected: FAIL — `ServiceNode` has no field `Global` (compile error).

- [ ] **Step 3: Add `Global` to `internal/gwapi/model.go`**

In the `ServiceNode` struct, add `Global bool`:

```go
type ServiceNode struct {
	Namespace, Name, Type string
	Port                  int32
	Selector              map[string]string // svc spec.selector; internal, for CNP label matching
	Global                bool              // Cilium global service (service.cilium.io/global=true)
	Policies              []PolicyRef       // M5-b-i: precise (BackendTLSPolicy)
	CNPs                  []PolicyRef       // M5-b-ii: inferred Cilium
	Resolved              bool              // false when the Service could not be read
}
```

- [ ] **Step 4: Set it in `resolveBackends` (`internal/fleet/gateway.go`)**

After `sn.Selector = svc.Spec.Selector`, add:

```go
		sn.Selector = svc.Spec.Selector
		sn.Global = svc.Annotations["service.cilium.io/global"] == "true"
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/fleet/ -run TestGetGatewayTopologyGlobalService -v` then `go test ./internal/fleet/ ./internal/gwapi/` and `go vet ./internal/fleet/`
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/gwapi/model.go internal/fleet/gateway.go internal/fleet/gateway_test.go
git commit -m "feat(gwapi+fleet): mark backend ServiceNode.Global from the cilium global annotation"
```

---

## Task 2: `ClusterConn.HasGlobalService`

**Files:**
- Modify: `internal/fleet/clustermesh.go`, `internal/fleet/conn.go`, `internal/fleet/clustermesh_test.go`, `internal/fleet/registry_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/fleet/clustermesh_test.go`:

```go
func TestHasGlobalService(t *testing.T) {
	gsvc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps", Annotations: map[string]string{"service.cilium.io/global": "true"}}}
	plain := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "local-only", Namespace: "apps"}}
	typed := typedfake.NewSimpleClientset(gsvc, plain)
	c := NewClusterConn("ctx-orange", typed, nil, nil, nil, clock.Real{})

	if !c.HasGlobalService(context.Background(), "apps", "share-api") {
		t.Fatal("share-api is global")
	}
	if c.HasGlobalService(context.Background(), "apps", "local-only") {
		t.Fatal("local-only is not global")
	}
	if c.HasGlobalService(context.Background(), "apps", "absent") {
		t.Fatal("absent service is not global")
	}
}
```

(Add `appsv1`/`corev1`/`metav1`/`typedfake` imports if not already present in the file — Task M5-c-i's `clustermesh_test.go` already imports `corev1`, `metav1`, `typedfake`.)

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestHasGlobalService -v`
Expected: FAIL — `c.HasGlobalService` undefined.

- [ ] **Step 3: Implement in `internal/fleet/clustermesh.go`**

```go
// HasGlobalService reports whether ns/name is a Cilium global service in this
// cluster (annotation service.cilium.io/global=true). Used to fleet-confirm a
// global service's reachable peers.
func (c *ClusterConn) HasGlobalService(ctx context.Context, ns, name string) bool {
	svc, err := c.typed.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false
	}
	return svc.Annotations["service.cilium.io/global"] == "true"
}
```

(`metav1` is already imported in clustermesh.go from M5-c-i.)

- [ ] **Step 4: Add to the `Conn` interface (`internal/fleet/conn.go`)**

After `MeshMember(...)`:

```go
	MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus)
	HasGlobalService(ctx context.Context, ns, name string) bool
```

- [ ] **Step 5: Add the `fakeConn` stub (`internal/fleet/registry_test.go`)**

After the `MeshMember` stub:

```go
func (f *fakeConn) HasGlobalService(ctx context.Context, ns, name string) bool { return false }
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run TestHasGlobalService -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/clustermesh.go internal/fleet/conn.go internal/fleet/clustermesh_test.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.HasGlobalService (cilium global annotation check)"
```

---

## Task 3: appbridge DTO + `globalReach` enrichment + wire main.go

**Files:**
- Modify: `internal/appbridge/gateway_dto.go`, `internal/appbridge/gateway_service.go`, `internal/appbridge/gateway_service_test.go`, `cmd/klyx/main.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/appbridge/gateway_service_test.go`:

```go
func TestGatewayTopologyGlobalReach(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway: gwapi.GatewayNode{Namespace: "infra", Name: "eg"},
		Routes: []gwapi.RouteNode{{
			Namespace: "apps", Name: "share",
			Services: []gwapi.ServiceNode{{Namespace: "apps", Name: "share-api", Resolved: true, Global: true}},
		}},
	}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	// Inject a globalReach that confirms one peer + flags an off-fleet one.
	svc.SetGlobalReach(func(cluster, ns, name string) ([]string, bool) {
		if ns == "apps" && name == "share-api" {
			return []string{"homelab-orange"}, true
		}
		return nil, false
	})

	d := svc.GetGatewayTopology("homelab-blue", "infra", "eg")
	s := d.Routes[0].Services[0]
	if !s.Global || len(s.MeshClusters) != 1 || s.MeshClusters[0] != "homelab-orange" || !s.MeshUnconfirmed {
		t.Fatalf("global reach: %+v", s)
	}
}

func TestGatewayTopologyNonGlobalNoReach(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway: gwapi.GatewayNode{Namespace: "infra", Name: "eg"},
		Routes:  []gwapi.RouteNode{{Namespace: "apps", Name: "share", Services: []gwapi.ServiceNode{{Namespace: "apps", Name: "share-api", Resolved: true}}}},
	}}
	called := false
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	svc.SetGlobalReach(func(cluster, ns, name string) ([]string, bool) { called = true; return nil, false })
	d := svc.GetGatewayTopology("x", "infra", "eg")
	if d.Routes[0].Services[0].Global || called {
		t.Fatalf("non-global service must not call globalReach: global=%v called=%v", d.Routes[0].Services[0].Global, called)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run 'TestGatewayTopologyGlobalReach|TestGatewayTopologyNonGlobal' -v`
Expected: FAIL — `ServiceNodeDTO` has no `Global`/`MeshClusters`/`MeshUnconfirmed`; `SetGlobalReach` undefined.

- [ ] **Step 3: Add DTO fields + map `Global` in `internal/appbridge/gateway_dto.go`**

Add to `ServiceNodeDTO` (after `Resolved`):

```go
type ServiceNodeDTO struct {
	Namespace       string         `json:"namespace"`
	Name            string         `json:"name"`
	Type            string         `json:"type"`
	Port            int32          `json:"port"`
	Resolved        bool           `json:"resolved"`
	Global          bool           `json:"global"`
	MeshClusters    []string       `json:"meshClusters"`
	MeshUnconfirmed bool           `json:"meshUnconfirmed"`
	Policies        []PolicyRefDTO `json:"policies"`
	CNPs            []PolicyRefDTO `json:"cnps"`
}
```

In `toTopologyDTO`, map `Global` in the `ServiceNodeDTO` construction (the `for _, s := range r.Services` line):

```go
			rd.Services = append(rd.Services, ServiceNodeDTO{Namespace: s.Namespace, Name: s.Name, Type: s.Type, Port: s.Port, Resolved: s.Resolved, Global: s.Global, Policies: policyDTOs(s.Policies), CNPs: policyDTOs(s.CNPs)})
```

(`MeshClusters`/`MeshUnconfirmed` are left zero here — `GetGatewayTopology` fills them.)

- [ ] **Step 4: Add `globalReach` to `GatewayService` (`internal/appbridge/gateway_service.go`)**

Add the field + setter + enrichment. Change the struct + constructor:

```go
type GatewayService struct {
	lookup      func(string) (GatewayConn, bool)
	globalReach func(cluster, ns, name string) (peers []string, unconfirmed bool)
}

func NewGatewayService(lookup func(string) (GatewayConn, bool)) *GatewayService {
	return &GatewayService{lookup: lookup}
}

// SetGlobalReach wires the fleet cross-reference used to fill global services'
// meshClusters / meshUnconfirmed. Optional - without it, global services still
// render (just without the confirmed-peer list).
func (s *GatewayService) SetGlobalReach(f func(cluster, ns, name string) ([]string, bool)) {
	s.globalReach = f
}
```

In `GetGatewayTopology`, after `dto := toTopologyDTO(topo)` (rename the return to a local `dto` and enrich before returning):

```go
	dto := toTopologyDTO(topo)
	if s.globalReach != nil {
		for ri := range dto.Routes {
			for si := range dto.Routes[ri].Services {
				sn := &dto.Routes[ri].Services[si]
				if sn.Global {
					peers, unconfirmed := s.globalReach(cluster, sn.Namespace, sn.Name)
					sn.MeshClusters = peers
					sn.MeshUnconfirmed = unconfirmed
				}
			}
		}
	}
	return dto
```

(Replace the existing `return toTopologyDTO(topo)` with the block above.)

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -v` then `go vet ./internal/appbridge/`
Expected: PASS, vet clean.

- [ ] **Step 6: Wire `globalReach` in `cmd/klyx/main.go`**

After the `gatewaySvc := ...` block, set the reach provider. It reads cluster A's mesh peers, resolves each to a fleet member by Cilium name, and asks present peers `HasGlobalService`:

```go
	gatewaySvc.SetGlobalReach(func(cluster, ns, name string) ([]string, bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		src, ok := reg.Conn(cluster)
		if !ok {
			return nil, false
		}
		srcMem, _ := src.MeshMember(ctx)
		if len(srcMem.Peers) == 0 {
			return nil, false
		}
		// Map every connected fleet cluster's Cilium name -> (fleet key, conn).
		type entry struct {
			fleetKey string
			conn     fleet.Conn
		}
		byCilium := map[string]entry{}
		for _, snap := range reg.Snapshots() {
			c, ok := reg.Conn(snap.Name)
			if !ok {
				continue
			}
			m, _ := c.MeshMember(ctx)
			if m.Identity.Name != "" {
				byCilium[m.Identity.Name] = entry{fleetKey: snap.Name, conn: c}
			}
		}
		var peers []string
		unconfirmed := false
		for _, peerCilium := range srcMem.Peers {
			e, present := byCilium[peerCilium]
			if !present {
				unconfirmed = true // off-fleet: can't inspect
				continue
			}
			if e.conn.HasGlobalService(ctx, ns, name) {
				peers = append(peers, e.fleetKey)
			}
		}
		return peers, unconfirmed
	})
```

Confirm `fleet` is imported in main.go (it is). The `gatewaySvc` is already registered with the app; `SetGlobalReach` just configures it before `application.New(...)`.

- [ ] **Step 7: Build to verify it compiles**

Run: `go build ./cmd/klyx/ 2>&1 | grep -vE "ld: warning|object file" | tail` then `rm -f klyx`
Expected: builds clean.

- [ ] **Step 8: Commit**

```bash
git add internal/appbridge/gateway_dto.go internal/appbridge/gateway_service.go internal/appbridge/gateway_service_test.go cmd/klyx/main.go
git commit -m "feat(appbridge): global-service mesh reach (fleet-confirmed peers, off-fleet unconfirmed)"
```

---

## Task 4: frontend — pods-box `⇄ global →` edge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`, `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`

- [ ] **Step 1: Update the store `ServiceNodeDTO` type in `cmd/klyx/frontend/src/store/fleet.ts`**

Replace the `ServiceNodeDTO` line to add the three fields:

```ts
export type ServiceNodeDTO = { namespace: string; name: string; type: string; port: number; resolved: boolean; global: boolean; meshClusters: string[]; meshUnconfirmed: boolean; policies: PolicyRefDTO[]; cnps: PolicyRefDTO[] };
```

- [ ] **Step 1b: Update existing service fixtures so they carry the new required fields**

Adding required `global`/`meshClusters`/`meshUnconfirmed` to `ServiceNodeDTO` means every existing `ServiceNodeDTO` literal in the tests needs them (vitest strips types, so a missing field is a runtime `undefined`, and the new render reads `svc.global`/`svc.meshClusters.length`). Update the two service-building spots in `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx`:

In the shared `topo` fixture's `services`:

```tsx
    services: [{ namespace: "apps", name: "share-api", type: "ClusterIP", port: 8080, resolved: true, global: false, meshClusters: [], meshUnconfirmed: false, policies: [], cnps: [] }],
```

In the `route()` helper's service object:

```tsx
    services: [{ namespace, name: svc, type: "ClusterIP", port: 80, resolved: true, global: false, meshClusters: [], meshUnconfirmed: false, policies: [], cnps: [] }],
```

Run `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx` — still green before adding new behaviour.

- [ ] **Step 2: Write the failing test**

Add to `cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx` (inside the existing `describe`):

```tsx
  it("renders a ⇄ global cross-cluster edge on the pods box for a global service", () => {
    const withGlobal: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], global: true, meshClusters: ["homelab-orange"], meshUnconfirmed: false }] }],
      warnings: [],
    };
    seed(withGlobal);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/global/i)).toBeTruthy();
    expect(getByText(/homelab-orange/)).toBeTruthy();
  });

  it("shows '(peers unverified)' when meshUnconfirmed and no confirmed peers", () => {
    const withGlobal: TopologyDTO = {
      gateway: topo.gateway,
      routes: [{ ...topo.routes[0], services: [{ ...topo.routes[0].services[0], global: true, meshClusters: [], meshUnconfirmed: true }] }],
      warnings: [],
    };
    seed(withGlobal);
    const { getByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(getByText(/peers unverified/i)).toBeTruthy();
  });

  it("no global edge for a non-global service", () => {
    seed(topo); // share-api global:false
    const { queryByText } = render(<NetworkTopology cluster="x" gateway={gateway} />);
    expect(queryByText(/⇄ global/)).toBeNull();
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx -t "global"`
Expected: FAIL — no global edge rendered.

- [ ] **Step 4: Render the edge + replace the placeholder in `cmd/klyx/frontend/src/cluster/NetworkTopology.tsx`**

In the pods box, after the `svc && svc.cnps.length > 0` chip block (and before the box's closing `</div>`), add the global edge:

```tsx
                  {svc && svc.global && (
                    <div style={{ marginTop: 4, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--color-text-info)" }} title={svc.meshUnconfirmed ? "global service: some mesh peers could not be fleet-verified (off-fleet or not connected). Live dataplane health is not checked." : "global service: also present on these fleet mesh peers. Live dataplane health is not checked."}>
                      ⇄ global{svc.meshClusters.length > 0 ? ` → ${svc.meshClusters.join(", ")}` : ""}{svc.meshUnconfirmed && svc.meshClusters.length === 0 ? " (peers unverified)" : svc.meshUnconfirmed ? " (+unverified)" : ""}
                    </div>
                  )}
```

Replace the placeholder line:

```tsx
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-secondary)", fontSize: 10, color: "var(--color-text-tertiary)" }}>⬡ ClusterMesh: not shown yet (arrives in a later slice)</div>
```

with a kept caption that points at the new edges (mesh peering lives on the fleet view; per-route global reach is now on the pods boxes):

```tsx
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-secondary)", fontSize: 10, color: "var(--color-text-tertiary)" }}>⇄ global services show their fleet-confirmed mesh peers on the pods box · cluster peering is on the Fleet view</div>
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/NetworkTopology.test.tsx` then `npx vitest run`
Expected: PASS (all topology tests + whole suite green).

- [ ] **Step 6: Commit**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/cluster/NetworkTopology.tsx cmd/klyx/frontend/src/cluster/NetworkTopology.test.tsx
git commit -m "feat(ui): pods-box ⇄ global cross-cluster edge for global services; retire placeholder"
```

---

## Task 5: bindings + full verification + native handoff

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
grep -rn "meshClusters\|global" frontend/bindings/github.com/moomora/klyx/internal/appbridge/models.js | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show the new `ServiceNodeDTO` fields; vitest green; **tsc clean** (the new `global`/`meshClusters`/`meshUnconfirmed` compile against the regenerated binding + `NetworkTopology.tsx`); build exit 0 (ignore `ld: warning` + the known ios scaffold). If tsc errors, read + fix the source, re-run.

NOTE: `cmd/klyx/frontend/bindings/` is gitignored — nothing to commit from binding regen.

- [ ] **Step 3: Clean up build output, confirm clean tree**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
rm -f klyx cmd/klyx/bin/klyx 2>/dev/null; git status --short
```
Expected: clean tree.

- [ ] **Step 4: Native handoff (owner, homelab mesh)**

Deploy a Cilium global service across blue + orange (same namespace/name on both, annotated `service.cilium.io/global: "true"`), backing a route through a gateway on one of them. In Klyx → that cluster → Network → the gateway:
- The route whose backend is the global service shows `⇄ global → homelab-orange` (the fleet-confirmed peer) on the **pods box**, distinct from the policy chips (arrow glyph, info colour). Hover → the truth-serum tooltip ("…also present on these fleet mesh peers. Live dataplane health is not checked.").
- A global service whose peer isn't connected to Klyx (or off-fleet) shows `⇄ global (peers unverified)`.
- A non-global backend shows no global edge.
- The old "ClusterMesh: not shown yet" placeholder is gone; the caption now points at the per-route global edges + the Fleet-view peering.
- Remove the test global service after.

No merge here — gate on native verification, then `finishing-a-development-branch`. This completes M5.

---

## Self-review notes

- **Spec coverage (§6):** global-service detection (annotation) → Task 1; `HasGlobalService` peer check → Task 2; strict service-level fleet-confirmed `meshClusters` + `meshUnconfirmed`, off-fleet never in `meshClusters` → Task 3 (`globalReach` in main.go); pods-box `⇄ global →` edge + truth-serum copy + placeholder retired → Task 4; native handoff → Task 5.
- **Honesty:** `meshClusters` only ever contains fleet-present peers confirmed to host a same-`ns/name` global Service; off-fleet/unconnected peers set `meshUnconfirmed` and never appear as a confirmed peer. Tooltip explicitly disclaims live dataplane reach. No "reachable" wording.
- **Separation:** `gwapi.ServiceNode` stays single-cluster (`Global` only); the cross-cluster `meshClusters`/`meshUnconfirmed` are DTO-only, filled by `GatewayService.globalReach` (fleet orchestration in main.go) — `gwapi` never needs multi-cluster data.
- **Strict match (decision #6):** `globalReach` confirms a peer only when it's in the fleet AND `HasGlobalService(ns, name)` (same namespace + name + global annotation). No selector/backend matching.
- **Type consistency:** Go `ServiceNode.Global` → DTO `Global`/`MeshClusters`/`MeshUnconfirmed` (json `global`/`meshClusters`/`meshUnconfirmed`) → TS `global`/`meshClusters`/`meshUnconfirmed`. `HasGlobalService` identical across `Conn`/`ClusterConn`/`fakeConn`. `SetGlobalReach`/`globalReach` signature `(cluster, ns, name) ([]string, bool)` consistent across the service, test, and main.go.
- **Fixture break handled:** Task 4 Step 1b updates the existing `ServiceNodeDTO` test literals for the new required fields before the render change (the M5-b-i lesson).
