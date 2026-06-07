# M5-c: ClusterMesh Edges — Design

**Parent spec:** `2026-06-05-klyx-gateway-topology-design.md` (M5). This delivers design principle
#4 ("ClusterMesh is a visible edge between clusters") + the principle-#1 fleet peering, replacing
the "ClusterMesh: not shown yet" placeholder in the topology and adding mesh to the fleet overview.

**Goal:** Make Cilium ClusterMesh visible — peering between clusters on the fleet overview, and
cross-cluster reach for global services in the gateway topology — honestly distinguishing
*configured* peering (what Klyx can read via client-go) from *live connectivity* (which it can't yet).

**Verification:** Now dogfoodable on the homelab — `homelab-blue ⇄ homelab-orange` are meshed
(KVStoreMesh, clustermesh-apiserver), `homelab-nelli` is standalone. No AKS dependency.

---

## Scope & decomposition

Both surfaces ship, as **two slices under this one spec** (different verification needs):
- **M5-c-i (fleet peering):** mesh detection + the fleet **mesh strip** + a **per-card mesh row**.
  Verifiable immediately on the live blue⇄orange mesh.
- **M5-c-ii (topology arrows):** global-service **cross-cluster edge on the pods box**. Needs a
  global service deployed (a test one) to verify; built on the same mesh-detection data layer.

Build i first (native-verify), then ii.

## The honesty line

```
configured peering   = the cilium-clustermesh Secret lists a remote cluster   (Klyx CAN read this)
mutual / asymmetric  = both sides list each other, or only one does           (Klyx cross-reads the fleet)
live connectivity    = "5/5 connected" agent health                           (Klyx CANNOT read - M7/metrics)
```
Klyx renders **configured** peering and labels it as such; it never implies live `connected` health
it cannot verify via client-go. Because Klyx reads *every* cluster in the fleet, it surfaces one thing
`cilium clustermesh status` on a single cluster can't: whether an edge is **mutual** (both secrets list
each other) or **asymmetric** (one-way) — a real misconfiguration signal.

## 1. Mesh detection (pure: `internal/clustermesh`)

A new pure package parses two per-cluster sources (read by the fleet layer via client-go, namespace
`kube-system`), no client-go dependency beyond the typed objects passed in:

- **`ParseIdentity(cm *corev1.ConfigMap) Identity`** — from `cilium-config`: `cluster-name`,
  `cluster-id` (string keys in `.data`). `Identity{Name string, ID int}`.
- **`ParsePeers(sec *corev1.Secret) []string`** — from the `cilium-clustermesh` Secret: each
  `.data` key that is a remote-cluster config entry is a configured peer name. Filter out non-cluster
  keys (e.g. `common-etcd-client-ca.crt`, keys ending in `.crt`/`.key`/`.etcd-client-*`); a peer key
  is one whose value parses as an etcd/clustermesh endpoint config. Conservative: only count keys that
  look like a cluster name (no dot-extension), to avoid inventing peers.
- **`BuildGraph(members []Member) Graph`** — pure fleet-level assembly. `Member{Cluster string,
  Identity Identity, Peers []string, Present bool}` (`Present` = Klyx is connected to it). Produces
  `Graph{Nodes []MeshNode, Edges []MeshEdge}`:
  - one `MeshNode` per fleet cluster: `{Cluster, ClusterID, Meshed bool}` (`Meshed` = has ≥1 peer or
    is named by a peer).
  - one `MeshEdge` per unordered cluster pair where either lists the other:
    `{A, B string, Mutual bool}` (`Mutual` = both list each other; else asymmetric/one-way).
  - a peer named by a cluster but **not in the fleet** (Klyx not connected to it) becomes a node with
    `Present=false` so the strip can show "off-fleet" peers honestly.

`clustermesh` is given already-fetched ConfigMaps/Secrets + the fleet member list; it does the parsing
and graph logic. Pure and unit-testable.

## 2. Capability detection (`internal/capability`)

The dormant `NetworkCapability.ClusterMesh bool` is finally **populated**: true when the cluster serves
ClusterMesh — detected by the presence of the `clustermesh-apiserver` Deployment/Service OR the
`cilium-clustermesh` Secret in `kube-system`. Gates all mesh UI (no mesh → no strip, no card row, no
topology edge), consistent with "render only what's installed".

## 3. Data layer (`internal/fleet`)

The fleet already connects to and aggregates every cluster. It gains a mesh pass:
- per `ClusterConn`: `MeshMember(ctx) (clustermesh.Member, bool)` — read `cilium-config` +
  `cilium-clustermesh` (typed `CoreV1().ConfigMaps/Secrets("kube-system").Get`), parse via the pure
  package; `ok=false` (+ a soft note) when ClusterMesh isn't served.
- fleet aggregation: collect each connected cluster's `Member`, call `clustermesh.BuildGraph` →
  a fleet-level `Graph` exposed on the fleet snapshot. Snapshot, no watch (consistent with M5).
- For **M5-c-ii**: `GetGatewayTopology` marks a backend `ServiceNode` as global when the Service
  carries `service.cilium.io/global: "true"`, and (cross-referencing the fleet graph + the connected
  peers) lists the **confirmed reachable** peer clusters — those meshed peers that also host a
  same-`namespace/name` global Service. A meshed peer Klyx isn't connected to → counted as
  "unconfirmed" (global, but reach not verifiable).

## 4. appbridge DTOs

- Fleet: `MeshGraphDTO{ nodes []MeshNodeDTO{cluster,clusterID,meshed,present}, edges []MeshEdgeDTO{a,b,mutual} }`,
  added to the fleet snapshot DTO (or a sibling `GetMeshGraph(...)`), all json-tagged camelCase.
- Topology: `ServiceNodeDTO` gains `global bool` + `meshClusters []string` (confirmed reachable peers)
  + `meshUnconfirmed bool`. TS types mirror.

## 5. Fleet peering UI (M5-c-i)

- **Mesh strip** above the cluster-card grid (rendered only when the fleet graph has ≥1 mesh node):
  clusters as nodes, peers as edges — **solid** for mutual, **dashed** for asymmetric (+ a small
  "asymmetric" caption), unmeshed/off-fleet nodes muted (`nelli ⬡`, off-fleet peers dimmed). A header
  caption clarifies "configured peering (not live connectivity)". Clicking a node opens that cluster.
- **Per-card mesh row** on each cluster card: `⇄ mesh: orange` (peers) or `⬡ not meshed`. Always
  visible; the strip is the at-a-glance graph, the row is the per-cluster fact.

## 6. Topology arrows (M5-c-ii)

- The pods box (which already hosts inferred CNP chips) gains a **cross-cluster edge chip** when the
  primary backend is a global service: `⇄ global → orange` (confirmed reachable peers), or
  `⇄ global (reach unconfirmed)` when peers aren't all connected to Klyx. Distinct styling from policy
  chips (it's a *reach* edge, not a policy) — e.g. an arrow glyph + the info colour.
- Replaces the literal "ClusterMesh: not shown yet (arrives in a later slice)" placeholder line.
- The route detail panel notes the global service + its confirmed/unconfirmed reachable clusters.

## 7. Testing + native handoff

- `clustermesh` unit tests: `ParseIdentity` (name/id, missing keys), `ParsePeers` (peer keys vs cert
  keys filtered, empty secret), `BuildGraph` (mutual edge, asymmetric one-way edge, unmeshed node,
  off-fleet peer `Present=false`).
- capability test: ClusterMesh true on apiserver/secret present, false otherwise.
- fleet test: `MeshMember` parse via fakes; graph assembly over a fake 3-cluster fleet
  (blue⇄orange mutual, nelli standalone); global-service marking + confirmed-peer cross-reference.
- appbridge mapping; frontend strip (solid/dashed/muted) + per-card row + topology edge chip.
- **Native handoff (i):** on the homelab fleet, the mesh strip shows `blue ⇄ orange` (solid mutual)
  with `nelli` muted, and each card's mesh row is correct. **(ii):** deploy a test global service
  (`service.cilium.io/global: "true"`) on blue+orange, route to it, confirm the pods-box `⇄ global →`
  edge lists the confirmed peer; remove after.

---

## Decisions log

| # | Decision | Why |
|---|----------|-----|
| 1 | Both surfaces (fleet peering + topology arrows), split M5-c-i then M5-c-ii | Principles #1 and #4 both name mesh; i is verifiable on the live mesh now, ii needs a global service — split gives a native-verify checkpoint |
| 2 | Render **configured** peering, never imply **live connectivity** | The secret/config are client-go-readable; `5/5 connected` health needs agent metrics (M7) — claiming it would be dishonest |
| 3 | Surface **mutual vs asymmetric** edges | Klyx reads every cluster, so it can show one-way misconfig that single-cluster `cilium clustermesh status` can't |
| 4 | Pure `internal/clustermesh` (parse + graph) separate from fleet I/O | Same pattern as `gwapi`/`crd` — the parsing + graph logic is real, deserves unit tests; fleet does the client-go reads |
| 5 | Fleet UI = mesh strip (focused graph) + per-card mesh row | Drawn edges between grid cards tangle at 9-cluster scale; a strip scales and the row keeps the fact always-visible (visual-companion choice) |
| 6 | Topology edge reuses the pods-box chip area; confirmed vs unconfirmed reach | Cilium global services select endpoints across clusters; Klyx confirms reach only for fleet-connected peers, and says so when it can't |
| 7 | Populate the dormant `ClusterMesh` capability; gate all mesh UI | The field existed but was never set; capability-gating keeps non-meshed clusters (nelli, kind) free of phantom mesh UI |
| 8 | Off-fleet peers shown as `Present=false` nodes | A cluster can mesh with a cluster Klyx isn't connected to; hiding it would misrepresent the mesh — show it dimmed |
