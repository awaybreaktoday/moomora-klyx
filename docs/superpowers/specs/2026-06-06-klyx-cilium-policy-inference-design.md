# M5-b-ii: Cilium Policy Inference (CNP/CCNP, inferred) — Design

**Parent specs:** `2026-06-05-klyx-gateway-topology-design.md` (M5) and
`2026-06-05-klyx-gateway-policies-design.md` (M5-b-i, Envoy precise). This is the **inferred**
counterpart: it completes the policy story by surfacing Cilium network policies that *select* the
backing pods, kept rigorously separate from the precise Gateway-API `targetRef` attachment.

**Goal:** Surface `CiliumNetworkPolicy` (CNP) and `CiliumClusterwideNetworkPolicy` (CCNP) against
the topology's backing workloads by a normalized label heuristic — honestly marked `Inferred`,
visually softer than the precise chips, and never implying a Gateway-API attachment that doesn't
exist.

**The seam (why this is its own slice):**
```
M5-b-i:  exact targetRef attachment  -> GatewayNode/RouteNode/ServiceNode.Policies   (precise)
M5-b-ii: inferred selector relation  -> ServiceNode.CNPs / Topology.ClusterPolicies  (heuristic)
```
Precise and inferred must never smear into one bucket. M5-b-ii only ever sets `Inferred=true`.

---

## Honesty ladder

Inference precision, loosest → tightest, all softer than a precise targetRef:
```
cluster-wide   (broad/empty CCNP)        -> header context only, "least precise"
namespace-wide (empty CNP selector)      -> all pods in the policy's namespace
selector       (matchLabels ⊆ svc sel)   -> the specific matched workload (tightest inference)
```
A chip must always say *how* it matched. The chip itself stays presence-only (feature names); the
tooltip/detail carry the match basis and decoded values; YAML is the law.

## 1. Model (`internal/gwapi`)

`ServiceNode.CNPs []PolicyRef` already exists (reserved since M5-a, untouched by M5-b-i). The only
additions:

```go
// PolicyMatchKind describes HOW an inferred policy was matched (typed, not a free string).
// These are the only three states a *recorded* PolicyRef can carry; an expressions-only policy
// never produces a PolicyRef (it is warned + skipped), so there is no "matchExpressions" result.
type PolicyMatchKind string

const (
    MatchSelector      PolicyMatchKind = "selector"        // normalized matchLabels ⊆ Service selector
    MatchNamespaceWide PolicyMatchKind = "namespace-wide"  // empty CNP endpointSelector (whole namespace)
    MatchClusterWide   PolicyMatchKind = "cluster-wide"    // broad/empty CCNP (header context)
)

type PolicyRef struct {
    Kind, Namespace, Name string
    TargetKind, TargetNamespace, TargetName, TargetSectionName string
    Summary  string
    Details  []PolicyDetail
    Inferred bool
    Match    PolicyMatchKind // empty for precise (M5-b-i) policies; set for inferred (M5-b-ii)
}
```

`Topology` gains the cluster-wide context bucket:

```go
type Topology struct {
    Gateway        GatewayNode
    Routes         []RouteNode
    ClusterPolicies []PolicyRef // broad/empty CCNPs - header context, NOT per-service
    Warnings       []string
}
```

**Inferred CNP/CCNP ref shape** (pods-targeted, honest):
```
Kind            = "CiliumNetworkPolicy" | "CiliumClusterwideNetworkPolicy"
Namespace, Name = the policy's own ns/name (CCNP has no namespace)
TargetKind      = "Pods"                 // they govern endpoints, NOT the Service
TargetNamespace = the matched Service's namespace
TargetName      = the matched Service's name
Inferred        = true
Match           = selector | namespace-wide   (cluster-wide for ClusterPolicies entries)
```
`TargetKind="Pods"` is deliberate: a Cilium policy selects endpoints; the Service selector is only
our inference *bridge*. Putting it on the pods, not the Service, keeps the claim honest.

## 2. Pure functions (`internal/gwapi`)

**`NormalizeCiliumLabels(m map[string]string) map[string]string`** — conservative. It MAY only:
- strip the `k8s:` source prefix (`k8s:app` → `app`);
- drop known metadata keys: `io.kubernetes.*`, `io.cilium.*`, `reserved:*`, and
  `k8s:io.kubernetes.pod.namespace` / `io.kubernetes.pod.namespace`.

**Invariant (test-enforced): normalization never invents a label.** It only strips known source
prefixes and drops known metadata keys; any other key passes through unchanged. No dialect
translation.

The matcher is split so the pure function never bakes in CNP-vs-CCNP (namespace vs cluster) semantics —
that mapping belongs to the fleet layer, which knows the policy kind.

**`ClassifyCiliumSelector(endpointSelector map[string]interface{}) (class SelectorClass, labels map[string]string, hasExpr bool)`** — classifies a selector AFTER normalization:
```go
type SelectorClass int
const (
    SelectorEmpty           SelectorClass = iota // no usable matchLabels and no matchExpressions
    SelectorLabels                               // usable normalized matchLabels present
    SelectorExpressionsOnly                      // matchExpressions but no usable matchLabels
)
```
- normalize `matchLabels` via `NormalizeCiliumLabels`; `labels` is the result.
- `len(labels)==0 && no matchExpressions` → `SelectorEmpty` (this is the precise meaning of **"broad"**:
  the selector is absent/empty, or became empty after normalization because only dropped metadata
  labels remained).
- `len(labels)>0` → `SelectorLabels` (`hasExpr` records whether matchExpressions is *also* present).
- `len(labels)==0 && matchExpressions present` → `SelectorExpressionsOnly`.

A non-empty normalized `matchLabels` selector is **never** treated as broad just because it might match
many Services — if it has usable labels, it is tested.

**`LabelsSubset(labels, serviceSelector map[string]string) bool`** — true when every key/value in
`labels` is present in `serviceSelector` (the subset test for `SelectorLabels`).

**matchExpressions honesty rule (applied in the fleet layer):**
- *`SelectorLabels` with `hasExpr=true` that subset-matches a Service* → attach with `Match=MatchSelector`
  + a `Detail{"selector note", "matchExpressions present, not fully evaluated"}` so the chip never reads
  as more confident than it is.
- *`SelectorExpressionsOnly`* → DO NOT attach a pod chip; emit one `Warning`
  (`"CNP <ns>/<name>: matchExpressions-only selector not evaluated"`). Honesty over a confident-but-wrong
  attachment.

**CNP decoder** (presence-only, mirrors the M5-b-i decoders; `feat` helper keeps Summary value-free):
- `ingress` present → feature `ingress`; empty ingress rule list → `ingress default-deny`.
- `egress` present → feature `egress`; empty egress rule list → `egress default-deny`.
- L7: any `toPorts[].rules.{http,dns,kafka}` → feature `L7`; detail `L7: http` / `dns` / `kafka`.
- `toEntities` (`world`/`cluster`/`host`/…) → feature `toEntities`; detail `toEntities: world, cluster`.
- `toFQDNs` → feature `toFQDNs`; detail `toFQDNs: *.example.com`.
- **Directional default-deny only** — never a generic `default-deny`; emit `ingress default-deny`
  and/or `egress default-deny` so the claim is exactly as specific as the data.
Fallback ladder identical to M5-b-i (no feature → name; values omitted when unparseable; never invent).

## 3. Data layer (`internal/fleet`)

A **separate** `attachCiliumPolicies(ctx, topo)` pass — independent of the precise M5-b-i pass —
reusing the same `servedResourceGVR` discovery + two-warning-class machinery (`cilium.io`:
`ciliumnetworkpolicies` namespaced, `ciliumclusterwidenetworkpolicies` cluster, both `v2`).

For each policy: decode once, then `ClassifyCiliumSelector` **once** (the class is a property of the
policy, not of any one Service, so this avoids per-service warning spam). The fleet layer — which knows
CNP vs CCNP — maps the kind-agnostic class to the recorded `PolicyMatchKind`:

- **CNP (namespaced):**
  - `SelectorEmpty` → append to **every** Service `ServiceNode.CNPs` in the CNP's namespace
    (`Inferred`, `Match=MatchNamespaceWide`).
  - `SelectorLabels` → for each Service in the CNP's namespace, `LabelsSubset`; on a match append to that
    `ServiceNode.CNPs` (`Match=MatchSelector`, + the "matchExpressions not fully evaluated" detail when
    `hasExpr`).
  - `SelectorExpressionsOnly` → one `Warning`, no attachment.
- **CCNP (cluster):**
  - `SelectorLabels` (narrow) → `LabelsSubset` against every Service cluster-wide → `ServiceNode.CNPs`
    (`Match=MatchSelector`, `Kind="CiliumClusterwideNetworkPolicy"`).
  - `SelectorEmpty` (broad) → `Topology.ClusterPolicies` **once** (`Match=MatchClusterWide`) — **never
    sprayed across lanes** (badge-rash is worse than the YAML). A CCNP scoped only by a normalized-away
    meta label (e.g. `io.kubernetes.pod.namespace`) collapses to `SelectorEmpty` → cluster-wide context;
    under-claiming is the safe direction.
  - `SelectorExpressionsOnly` → one `Warning`, no attachment.

Warning classes reused: group/CRD not served → informational (`"CiliumNetworkPolicy CRD not installed"`);
served-but-list-failed → operational (`"could not list CiliumNetworkPolicy: <err>"`). `Inferred=true`
throughout. Snapshot, no watch.

## 4. appbridge DTO

`PolicyRefDTO` gains `match string json:"match"`. `TopologyDTO` gains
`clusterPolicies []PolicyRefDTO json:"clusterPolicies"`. `ServiceNodeDTO.cnps` already exists — the
mapper fills it (it currently maps an always-empty slice). TS types mirror field-for-field.

## 5. Frontend (the visual seam)

- **CNP/CCNP chips render on the PODS box** (precise BackendTLSPolicy stays on the Service box). The
  pods box currently shows `ready / total`; inferred chips sit below it.
- **Deliberately less-exact styling** vs the precise Envoy chips: a **dashed** outline, **muted** fill,
  a leading **`~`**, and a distinct `CNP` / `CCNP` label. The `PolicyChip` already renders `~` when
  `inferred`; M5-b-ii adds the dashed/muted treatment keyed on `inferred` and registers `CNP`/`CCNP`
  colours. A precise chip and an inferred chip must never be mistaken for each other at a glance.
- **Tooltip leads with the honesty note:** `"inferred: matched by Service selector, not a Gateway API
  attachment"`, then the `Match` basis (`selector` / `namespace-wide`), then the decoded rows.
- **Header `CLUSTER-WIDE POLICIES` group** lists `topology.clusterPolicies` as inferred chips, separate
  from the gateway `POLICIES` group; tooltip: `"cluster-wide inferred context — broad/empty
  endpointSelector, not attached to a specific Service."`
- **Route detail "attached policies"** gets a separate **inferred** sub-group (visually divided from the
  precise policies), each CNP showing Kind/ns/name, `Inferred via: <match>`, the matchExpressions note
  when present, and decoded rows. The **pod-target wording is deliberately honest**: render
  `Target: Pods selected via Service <ns>/<name>` — NOT `Target: Pods <ns>/<name>` — because there is no
  pod literally named after the Service; the Service name is only the inference bridge.
- **Cluster-wide CCNPs are header-only.** They are NOT duplicated into each route's detail panel; the
  inferred sub-group carries a one-line hint `"cluster-wide policies are shown in the topology header"`
  (mirroring the gateway-policies-header hint), so the panel stays readable.

## 6. Testing

- `gwapi`: `NormalizeCiliumLabels` (prefix strip, meta-key drop, the never-invent invariant, passthrough);
  `ClassifyCiliumSelector` (empty→`SelectorEmpty`, usable labels→`SelectorLabels` with `hasExpr`,
  expressions-only→`SelectorExpressionsOnly`, meta-only-labels normalize to `SelectorEmpty`);
  `LabelsSubset` (subset true/false, prefix-normalized match); the CNP decoder (ingress/egress, directional
  default-deny, L7, toEntities, toFQDNs, value-free Summary, fallbacks).
- `fleet`: CNP selector attach; namespace-wide fan to all services in the namespace; CCNP narrow → chip
  vs broad → `ClusterPolicies` header; expressions-only → warning + no attach; CRD-not-installed vs
  list-forbidden warnings.
- `appbridge`: `match` + `clusterPolicies` + `service.cnps` mapping.
- frontend: inferred chips on the pods box with the distinct styling; header cluster-wide group; detail
  inferred sub-group; tooltip honesty note.
- **Native handoff** (homelab-nelli): apply synthetic CNPs/CCNPs — a narrow `matchLabels` CNP on a
  backend, a namespace-wide empty-selector CNP (default-deny), a narrow CCNP, and a broad CCNP — confirm
  selector vs namespace-wide vs cluster-wide land where designed, the styling reads as inferred, and the
  matchExpressions case is handled honestly.

---

## Decisions log (M5-b-ii additions)

| # | Decision | Why |
|---|----------|-----|
| 22 | M5-b-ii inferred Cilium kept architecturally separate from M5-b-i precise | Exact targetRef vs heuristic selection must not share a bucket; the seam is the point of the split |
| 23 | `Match PolicyMatchKind` typed enum | A free `string` is a typo nest; the enum makes header/namespace/selector handling explicit |
| 24 | Inferred CNP/CCNP chips on the **Pods** box; `TargetKind="Pods"` | Cilium selects endpoints, not Services; the Service selector is only the inference bridge — pods is the honest home |
| 25 | Broad/empty CCNP → `Topology.ClusterPolicies` header context, not per-lane | Spraying a broad CCNP across every lane is badge-rash, noisier than the YAML |
| 26 | matchExpressions: attach only when matchLabels also matches (+ "not fully evaluated" note); expressions-only → warning, no chip | A policy with expressions must never read as confidently attached |
| 27 | Conservative normalization invariant: strip known prefixes / drop known metadata, never invent | A label normalizer, not a dialect translator — keeps the inference trustworthy |
| 28 | Directional `ingress/egress default-deny`, no generic `default-deny` | The chip claim must be exactly as specific as the data; both-direction deny isn't always knowable |
| 29 | Distinct softer visual language for inferred chips (dashed, muted, `~`) | A precise and an inferred chip must be unmistakable at a glance — the UX expression of the seam |
| 30 | Pure `ClassifyCiliumSelector` (kind-agnostic) vs fleet kind→`PolicyMatchKind` mapping | The pure matcher must not bake in namespace-vs-cluster semantics; empty means namespace-wide for a CNP but cluster-wide for a CCNP — only the fleet layer knows the kind |
| 31 | "Broad" defined precisely = `SelectorEmpty` after normalization (absent/empty, or only dropped meta labels remained) | A non-empty normalized matchLabels selector is never "broad" just because it might match many Services — if it has usable labels, it is tested |
| 32 | Pod-target wording `Pods selected via Service <ns>/<name>` | There is no pod literally named after the Service; the Service is the inference bridge — the wording must not imply otherwise |
