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
  `cluster-id`. `cluster-id` is **optional display metadata, not graph identity** — represent it as
  optional so a missing/malformed id still yields a usable identity:
  ```go
  type Identity struct {
      Name string // Cilium cluster-name (the graph identity)
      ID   *int   // optional; nil when cluster-id is absent/unparseable
  }
  ```
- **`ParsePeers(sec *corev1.Secret) []string`** — from the `cilium-clustermesh` Secret. Cilium stores
  **one file per remote cluster**, filename = the remote Cilium cluster-name; the Secret also carries
  internal material (CA/cert/key). A key counts as a peer ONLY when **all** hold: (a) no dot-extension;
  (b) not known-internal material (`common-*`, `*-etcd-client-*`, anything `.crt`/`.key`/`.pem`/`.ca`);
  (c) its **value parses as a remote-cluster config** (a kubeconfig/etcd-client config exposing
  server/endpoints). Rule (c) is the real guard — "no dot-extension" alone is a first filter, not the
  decision, so a future non-cert internal key can't become a phantom peer. Parser shape + filters are
  pinned by **real-Secret fixtures** captured from homelab-blue/orange (see Testing).
- **`BuildGraph(members []Member) Graph`** — pure fleet-level assembly.
  `Member{Cluster string, Identity Identity, Peers []string, Present bool}` where `Cluster` is the
  **fleet key** (kubeconfig context, e.g. `kubernetes-admin@homelab-blue`) and `Identity.Name` is the
  **Cilium cluster-name** (e.g. `homelab-blue`) — these can differ. **Peer matching is by Cilium
  cluster-name** (peer strings from the Secret are Cilium names): a peer `p` resolves to the fleet
  member whose `Identity.Name == p` (falling back to `Member.Cluster` when identity is absent).
  Produces `Graph{Nodes []MeshNode, Edges []MeshEdge}`:
  - one `MeshNode` per fleet member: `{Cluster (fleet key), Name (Cilium), ClusterID *int, State MeshState, Present:true}`.
  - one `MeshEdge` per unordered pair where either side names the other (by Cilium name), keyed by fleet
    member: `{A, B string (fleet keys), Mutual bool}`. Duplicate peer entries collapse to one edge; a
    self-peer (a cluster naming itself) is ignored.
  - a peer named by a member but **not present in the fleet** becomes a node with `Present=false` and
    its display label is the peer (Cilium) name — so the strip can show off-fleet peers, dimmed.

```go
type MeshState string
const (
    MeshUnavailable MeshState = "unavailable" // Cilium ClusterMesh not detected on the cluster
    MeshEnabled     MeshState = "enabled"     // clustermesh installed, no configured peers
    MeshPeered      MeshState = "peered"      // ≥1 configured peer, or named by another peer
)
```

`clustermesh` is given already-fetched ConfigMaps/Secrets + the fleet member list (each member's
`ClusterMeshInstalled` flag from capability); it does the parsing and graph logic. Pure and
unit-testable.

## 2. Capability detection (`internal/capability`)

Two subtly different facts, not one bool — so the UI never lies that a peerless-but-installed cluster
is "not meshed":
- **`ClusterMeshInstalled`** — `clustermesh-apiserver` Deployment/Service OR the `cilium-clustermesh`
  Secret present in `kube-system`. Populates the dormant `NetworkCapability.ClusterMesh` (kept as the
  coarse gate for "show mesh UI at all").
- **`ClusterMeshPeered`** — derived later (in `BuildGraph`): the member has ≥1 configured peer or is
  named by another. This drives the `MeshState` (enabled vs peered).

`ClusterMeshInstalled=false` → `MeshUnavailable` (no strip node, no card row, no topology edge —
"render only what's installed"). Installed-but-peerless → `MeshEnabled` (the card row says "mesh
enabled, no peers", NOT "not meshed").

## 3. Data layer (`internal/fleet`)

The fleet already connects to and aggregates every cluster. It gains a mesh pass:
- per `ClusterConn`: `MeshMember(ctx) (clustermesh.Member, MeshReadStatus)` — read `cilium-config` +
  `cilium-clustermesh` (typed `CoreV1().ConfigMaps/Secrets("kube-system").Get`), parse via the pure
  package. It **always returns a `Member`** for the cluster (with `Present=true`), even when the Secret
  is absent — so a standalone cluster (nelli) still becomes a fleet node and isn't dropped. Nuance
  lives in the status, not a bool:
  ```go
  type MeshReadStatus struct {
      ClusterMeshInstalled bool
      IdentityRead         bool
      PeersRead            bool
      Note                 string
  }
  ```
- fleet aggregation: collect **every** connected cluster's `Member`, call `clustermesh.BuildGraph` →
  a fleet-level `Graph` exposed on the fleet snapshot. Snapshot, no watch (consistent with M5).
- For **M5-c-ii**: `GetGatewayTopology` marks a backend `ServiceNode` as `Global` when the Service
  carries `service.cilium.io/global: "true"`, and lists `MeshClusters` — the **fleet-confirmed global
  peers**: meshed peers that (a) are present in the fleet AND (b) host a Service with the *same
  namespace + name* that is *also* annotated global, AND (c) share a mesh edge. **Off-fleet peers are
  never added to `MeshClusters`** (Klyx can't inspect them) — they only set `MeshUnconfirmed=true`.
  This is *fleet-confirmed global-service presence*, NOT live dataplane reachability — the naming and
  UI copy say so (decision #2).

## 4. appbridge DTOs

- Fleet: `MeshGraphDTO{ nodes []MeshNodeDTO{cluster,name,clusterID,state,present}, edges []MeshEdgeDTO{a,b,mutual} }`,
  added to the fleet snapshot DTO (or a sibling `GetMeshGraph(...)`), all json-tagged camelCase
  (`clusterID` → `clusterId`; `state` is the `MeshState` string).
- Topology: `ServiceNodeDTO` gains `global bool` + `meshClusters []string` (**fleet-confirmed global
  peers** — fleet-present peers with a same-`ns/name` global Service; never off-fleet) + `meshUnconfirmed
  bool` (a configured/off-fleet peer could not be fleet-verified). TS types mirror.

## 5. Fleet peering UI (M5-c-i)

- **Mesh strip** above the cluster-card grid (rendered only when ≥1 fleet cluster is
  `ClusterMeshInstalled`): clusters as nodes, peers as edges — **solid** for mutual, **dashed** for
  asymmetric (+ a small "asymmetric" caption), standalone nodes muted (`nelli ⬡`), off-fleet peers
  shown as a **dimmed, second-class** node. Header caption exactly: *"configured peering (not live
  connectivity)"*. Clicking a fleet node opens that cluster (off-fleet nodes aren't clickable).
- **Per-card mesh row** — precise states (this is a topology debugger; the distinctions are the point):
  `⇄ mesh: orange` (peered/mutual); `⇄ mesh: orange (asymmetric)` (one-way configured);
  `⇄ mesh: orange (+1 off-fleet)` (a peer Klyx isn't connected to); `⬡ mesh enabled, no peers`
  (installed, zero peers); `⬡ no ClusterMesh` (not installed). The strip is the at-a-glance graph;
  the row is the per-cluster fact.

## 6. Topology arrows (M5-c-ii)

- **Detection is strict service-level** (no selector/backend-pod matching — too clever for this slice):
  a peer counts in `MeshClusters` only when same namespace, same Service name, the peer's Service is
  *also* annotated `service.cilium.io/global: "true"`, the peer is **present in the fleet**, and a mesh
  edge exists between the two.
- The pods box (which already hosts inferred CNP chips) gains a **cross-cluster edge chip** when the
  primary backend is global: `⇄ global → orange` (fleet-confirmed global peers), or
  `⇄ global (peers unverified)` when `meshUnconfirmed`. Distinct styling from policy chips (it's a
  *reach* edge, not a policy) — an arrow glyph + the info colour.
- **Tooltip/detail copy is truth-serum**: *"Global service also found on configured mesh peer `orange`.
  Live dataplane health is not checked."* Never "reachable"/"confirmed reachable" — Klyx confirms
  configured global-service presence across the fleet, not packet reach (that waits for M7 agent
  metrics).
- Replaces the literal "ClusterMesh: not shown yet (arrives in a later slice)" placeholder line.

## 7. Testing + native handoff

- **Fixtures:** capture the *real* Secret shape from the homelab into `testdata/` before coding
  `ParsePeers` — `kubectl --context kubernetes-admin@homelab-blue -n kube-system get secret
  cilium-clustermesh -o yaml > testdata/blue-cilium-clustermesh.yaml` (and orange). Redact endpoint
  values if needed but keep the real key shape; pin the parser against them.
- `clustermesh` unit tests: `ParseIdentity` (name+id, **missing/malformed cluster-id still yields a
  usable identity by name**); `ParsePeers` (peer keys vs filtered cert/internal keys, value-must-parse
  guard, empty secret); `BuildGraph` — mutual edge; asymmetric one-way edge; standalone node;
  off-fleet peer `Present=false`; **Cilium identity-name differs from fleet cluster key, peer resolves
  to the right fleet member** (the under-the-floorboards case); duplicate peer entries collapse to one
  edge; self-peer ignored; malformed cluster-id still renders a node; Secret missing but apiserver
  present → `MeshEnabled` (no peers).
- capability test: `ClusterMeshInstalled` true on apiserver/secret present, false otherwise.
- fleet test: `MeshMember` parse via fakes (always returns a member); graph assembly over a fake
  3-cluster fleet (blue⇄orange mutual, nelli standalone). Topology: local global + peer same-`ns/name`
  global, peer in fleet → `MeshClusters` includes peer; peer Service absent / not global → not
  included; off-fleet peer → `MeshUnconfirmed=true`, peer NOT in `MeshClusters`; local not global → no
  chip; same name different namespace → no match.
- appbridge mapping; frontend strip (solid mutual / dashed asymmetric / muted standalone / dim
  off-fleet) + per-card row (all five states) + topology edge chip + truth-serum tooltip.
- **Native handoff (i):** on the homelab fleet, the mesh strip shows `blue ⇄ orange` (solid mutual)
  with `nelli` muted, and each card's mesh row is correct. **(ii):** deploy a test global service
  (`service.cilium.io/global: "true"`) on blue+orange, route to it, confirm the pods-box `⇄ global →`
  edge lists the fleet-confirmed peer; remove after.

---

## Decisions log

| # | Decision | Why |
|---|----------|-----|
| 1 | Both surfaces (fleet peering + topology arrows), split M5-c-i then M5-c-ii | Principles #1 and #4 both name mesh; i is verifiable on the live mesh now, ii needs a global service — split gives a native-verify checkpoint |
| 2 | Render **configured** peering, never imply **live connectivity** | The secret/config are client-go-readable; `5/5 connected` health needs agent metrics (M7) — claiming it would be dishonest |
| 3 | Surface **mutual vs asymmetric** edges | Klyx reads every cluster, so it can show one-way misconfig that single-cluster `cilium clustermesh status` can't |
| 4 | Pure `internal/clustermesh` (parse + graph) separate from fleet I/O | Same pattern as `gwapi`/`crd` — the parsing + graph logic is real, deserves unit tests; fleet does the client-go reads |
| 5 | Fleet UI = mesh strip (focused graph) + per-card mesh row | Drawn edges between grid cards tangle at 9-cluster scale; a strip scales and the row keeps the fact always-visible (visual-companion choice) |
| 6 | Topology edge = **fleet-confirmed global-service presence**, never "reachable" | Cilium global services share endpoints across clusters, but Klyx only confirms a same-`ns/name` global Service exists on a fleet peer — not packet reach. "Reachable" would over-claim until M7 metrics |
| 7 | Two capability facts: `ClusterMeshInstalled` (gate) vs `ClusterMeshPeered` (state) | A peerless-but-installed cluster must read "mesh enabled, no peers", not "not meshed" — one bool would lie |
| 8 | Off-fleet peers are dimmed nodes + a card `(+N off-fleet)`, but **never** in topology `MeshClusters` | Showing them honours the real mesh, but Klyx can't inspect them, so they must not imply a verifiable cross-cluster route |
| 9 | Match peers by **Cilium cluster-name** (Identity.Name), not the kubeconfig/fleet key | The `cilium-clustermesh` Secret keys are Cilium cluster-names; the fleet display key (kubeconfig context) may differ — matching on the wrong one is a silent missing-edge bug |
| 10 | `cluster-id` is optional display metadata; graph identity is the cluster-name | A missing/malformed `cluster-id` must still yield a usable node and edges |
