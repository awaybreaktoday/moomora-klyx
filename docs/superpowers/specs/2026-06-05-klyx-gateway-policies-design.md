# M5-b-i: Gateway Policy Attachment (Envoy precise) — Design

**Parent spec:** `2026-06-05-klyx-gateway-topology-design.md` (M5 Gateway topology). This
refines and supersedes that spec's policy section for the **Envoy precise** scope.

**Goal:** Attach Envoy Gateway / Gateway-API policies to the topology graph by their
`targetRef` — precise, deterministic, Gateway-API-native attachment — and surface them as
colour-coded chips on the gateway / route / service nodes plus an "attached policies"
section in the route detail panel. The chip asserts *what features exist*; the tooltip and
detail panel decode *values*; YAML remains the source of truth.

**Out of scope (M5-b-ii, separate spec/plan):** Cilium `CiliumNetworkPolicy` /
`CiliumClusterwideNetworkPolicy`, attached to pods by the inferred label-subset heuristic and
marked `Inferred=true`. The model reserves `ServiceNode.CNPs` and `PolicyRef.Inferred` for it;
M5-b-i never sets `Inferred=true`.

---

## Truth hierarchy (the product line)

```
chip          = what exists        (feature presence, never values)
tooltip/detail = decoded convenience (best-effort)
YAML          = law                (source of truth)
```

Klyx is a useful policy *signal*, not an authoritative policy *oracle*. Every decision below
serves that line: a guessed summary is worse than the policy name, and an empty pocket beats a
forged coin.

## Policy kinds in scope

Attached generically by `targetRef` (NOT hardcoded per kind — in Envoy Gateway a kind can target
more than one node type):

| Kind | Group | Typical target | Node |
|------|-------|----------------|------|
| ClientTrafficPolicy (CTP) | `gateway.envoyproxy.io` | Gateway only | gateway |
| BackendTrafficPolicy (BTP) | `gateway.envoyproxy.io` | Gateway or HTTPRoute | gateway / route |
| SecurityPolicy (SP) | `gateway.envoyproxy.io` | Gateway or HTTPRoute | gateway / route |
| EnvoyExtensionPolicy (EEP) | `gateway.envoyproxy.io` | Gateway or HTTPRoute | gateway / route |
| BackendTLSPolicy (BTLS) | `gateway.networking.k8s.io` | Service | service |

The node a policy lands on is decided by the `targetRef`'s kind+name, never by the policy's own
kind. A BTP targeting a Gateway lands on the gateway; a BTP targeting an HTTPRoute lands on the
route.

---

## 1. Model (`internal/gwapi`)

`PolicyRef` is reshaped (it exists today as `{Kind, Name, Summary, Inferred}`, empty since M5-a):

```go
type PolicyRef struct {
    // Identity of the policy object.
    Kind, Namespace, Name string

    // Target metadata — first-class, NOT encoded in Details.
    TargetKind        string
    TargetNamespace   string
    TargetName        string
    TargetSectionName string // optional; a listener/section the policy pins

    Summary  string         // chip text: feature presence only, e.g. "retries + timeout"
    Details  []PolicyDetail // panel/tooltip rows: decoded values, deterministic order
    Inferred bool           // false for all M5-b-i Envoy policies; reserved for Cilium M5-b-ii
}

type PolicyDetail struct{ Key, Value string } // "retries" -> "3", "request timeout" -> "30s"

// PolicyDecode is what a per-kind decoder returns.
type PolicyDecode struct {
    Summary string
    Details []PolicyDetail
}
```

Node fields:
- `GatewayNode.Policies []PolicyRef` — exists (empty since M5-a); M5-b-i fills it.
- `RouteNode.Policies   []PolicyRef` — exists; M5-b-i fills it.
- `ServiceNode.Policies []PolicyRef` — **new**: precise policies (BackendTLSPolicy). Kept
  distinct from `ServiceNode.CNPs []PolicyRef` (reserved for inferred Cilium, M5-b-ii).

## 2. Pure functions (`internal/gwapi`)

**`PolicyTargets(u) []TargetRef`** — reads `spec.targetRefs[]` plus the legacy singular
`spec.targetRef`, returning `{Group, Kind, Namespace, Name, SectionName}` for each. `Namespace`
holds the raw `targetRef.namespace` (empty when omitted); the attach/fan-out step resolves it:
it defaults to the policy's namespace when omitted, and uses the explicit value when present.

```go
type TargetRef struct{ Group, Kind, Namespace, Name, SectionName string }
```

**Decoder registry** — one explicit, unit-tested decoder per kind:

```go
type PolicyDecoder func(u *unstructured.Unstructured) PolicyDecode

var decoders = map[string]PolicyDecoder{
    "ClientTrafficPolicy":  decodeClientTrafficPolicy,
    "BackendTrafficPolicy": decodeBackendTrafficPolicy,
    "SecurityPolicy":       decodeSecurityPolicy,
    "EnvoyExtensionPolicy": decodeEnvoyExtensionPolicy,
    "BackendTLSPolicy":     decodeBackendTLSPolicy,
}
```

Each decoder reports **feature presence** (for `Summary`) and **decoded values** (for `Details`),
returning `Details` in a **deliberate priority order** (never Go map iteration). Indicative
features per kind (presence = a top-level spec block exists; value = decoded only when
unambiguous):

- **CTP**: `http2`, `connection-limit`, `tls`, `timeout`, `keepalive` → details e.g.
  `HTTP/2 window: 16MiB`, `max connections: 1024`.
- **BTP**: `retries`, `per try timeout`, `request timeout`, `load balancer`, `circuit breaker`,
  `rate limit` (priority order as listed) → `retries: 3`, `request timeout: 30s`.
- **SP**: `jwt`, `oidc`, `ext-auth`, `basic-auth`, `api-key`, `cors`, `authorization` → e.g.
  `jwt issuer: …` only when a single unambiguous value exists.
- **EEP**: `ext-proc`, `wasm`, `lua` → `ext-proc: <name>`.
- **BTLS**: `ca`, `well-known-ca`, `hostname` → `hostname: keycloak.svc`.

**Fallback ladder** (enforced by tests):

```
known features found    -> Summary = feature names,  Details = decoded rows
kind known, no features -> Summary = policy name,     Details = []
kind unknown            -> Summary = policy name,     Details = []   (defensive only — see note)
value present but unparseable -> omit from Details (never invent a label/value)
```

The "kind unknown" rung is **defensive code, not a feature**: the fleet pass lists only the five
known GVRs, so an unknown kind reaches a decoder only if the registry and the GVR list drift out of
sync. The rung guarantees that drift degrades to a name-only chip rather than a panic or a blank.

**Invariants** (test conventions):
- `Summary` contains **feature names only** — no decoded values ever leak into it.
- `Details` carry decoded values only — not relationship metadata (that's the `Target*` fields).
- A decoder never panics on malformed `unstructured` (comma-ok / `Nested*` throughout).

**Fan-out**: a policy with multiple `targetRefs[]` yields **one `PolicyRef` per target**, all
sharing the policy's decoded `Summary`/`Details` but each carrying its own resolved `Target*`. The
fleet layer does this fan-out; `attachPolicies` then matches each `PolicyRef` purely by its
`Target*` fields.

**`attachPolicies(topology, []PolicyRef)`** — places each `PolicyRef` on the node its resolved
target names:

- `targetRef.kind == Gateway` & name == this gateway → `GatewayNode.Policies`.
- `targetRef.kind == HTTPRoute` & name matches a route in the topology → that `RouteNode.Policies`.
- `targetRef.kind == Service` & name matches a route's backend Service → that `ServiceNode.Policies`.
- A `PolicyRef` whose target matches nothing in this topology is dropped (it belongs to another
  gateway); not a warning (expected — policies are cluster-wide, the topology is one gateway).

**BackendTLSPolicy visibility caveat.** A BackendTLSPolicy attaches only to backend Services the
topology actually represents as `ServiceNode`s. M5-a collapses a route's multiple `backendRefs` to
the **primary** Service in the lane (with a warning); a BackendTLSPolicy targeting a *non-primary*
backend therefore has no node to land on and is dropped. This is an accepted M5-b-i limitation —
full multi-backend BTLS visibility waits on the topology modelling all backend Services, not just
the primary. We make no false claim: BTLS chips appear only on Services we render.

**targetRef namespace defaulting** (explicit, tested):

```
targetRef.namespace omitted -> target namespace = policy namespace
targetRef.namespace present  -> target namespace = targetRef.namespace
```

Node matching uses the resolved `(namespace, name)` pair. `TargetNamespace` on the `PolicyRef`
records the resolved value for the detail panel.

`gwapi` takes already-parsed pieces + the policy unstructureds; it does resolution. No client-go
dependency beyond `unstructured`.

## 3. Data layer (`internal/fleet`)

`GetGatewayTopology` gains a policy pass after the route/service/pod assembly:

GVRs (preferred version via the existing `preferredVersion` helper):
- `gateway.envoyproxy.io`: `clienttrafficpolicies`, `backendtrafficpolicies`, `securitypolicies`,
  `envoyextensionpolicies`.
- `gateway.networking.k8s.io`: `backendtlspolicies`.

For each policy kind:
1. If the group/resource is **not served** (capability check, mirrors `gatewayAPIServed`): skip,
   add an **informational** warning — `"<Kind> CRD not installed"`.
2. If served, dynamic-list (all namespaces). On **list error** (served but failed — e.g. RBAC
   `forbidden`): add an **operational** warning — `"could not list <Kind>: <err>"` — and continue
   (topology may be incomplete but still renders).
3. Parse each: identity, `PolicyTargets`, resolve target namespace, run the kind's decoder.
4. `gwapi.attachPolicies` places them.

`Inferred=false` for every policy here. Snapshot, no watch, bounded context. The two warning
classes are distinct strings so the UI wording differs (informational vs operational).

This preserves the M5-a contract: an error return is reserved for a **core** failure (the Gateway
itself can't be read); everything softer is a `Warnings` line and the topology still renders.

## 4. appbridge (`GatewayService` DTOs)

`PolicyRefDTO` (exists as `{kind,name,summary,inferred}`) gains:

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

`ServiceNodeDTO` gains `Policies []PolicyRefDTO json:"policies"` (it already has `cnps`). The
`toTopologyDTO` mapper maps `GatewayNode.Policies`, `RouteNode.Policies`, `ServiceNode.Policies`,
and each `PolicyRef.Details`. TS types mirror field-for-field (camelCase).

## 5. Frontend (dumb renderer)

The chip placement + detail panel were approved in the M5 brainstorm mockup; M5-b-i fills them.

- **Chips** render `Summary` (feature presence), colour-coded by kind:
  - Gateway policies (CTP + gateway-targeted BTP/SP/EEP) render **once in the topology header**
    (next to the gateway name/status/class), not repeated in each lane's gateway box.
  - Route policies render on the **httproute box** in each lane.
  - Service policies (BackendTLSPolicy) render on the **service box** in each lane.
- **Hover tooltip** on a chip = the **first 2-4** `Details` rows (decoder-ordered) — short, never
  hover-YAML. If `Details` is empty, the tooltip shows the policy `Kind/Namespace/Name`.
- **Detail panel** "attached policies" section — the **selected route's** attached policies
  (route-targeted BTP/SP/EEP) and its backend Services' BackendTLSPolicies. Gateway-level policies
  live in the header (always visible), not in the per-route panel. One block per policy:
  ```
  BackendTrafficPolicy/backend-retries
  Target: HTTPRoute/keycloak-route   (Section: https, when set)
  Features: retries, timeout
    retries: 3
    per try timeout: 10s
    request timeout: 30s
  ```
  The existing **view-YAML** link remains the source of truth. The section carries a one-line
  hint — *"Gateway policies are shown in the topology header"* — so a route with no route-level
  policies doesn't read as if a CTP vanished into the floorboards.
- Capability-gated: when no Envoy/Gateway-API policy group is served, no chips and an
  informational warning (consistent with M5-a's warnings surface).

## 6. Testing

- **gwapi decoders** (one suite per kind): feature-presence summary; value decode; the three
  fallback rungs; the **value-free-Summary invariant**; **deterministic Details ordering**;
  unparseable-value omission; no panic on malformed input.
- **`PolicyTargets`**: `targetRefs[]`, legacy singular `targetRef`, `sectionName`, multiple targets.
- **`attachPolicies`**: each kind → correct node; BTP/SP to gateway vs route by targetRef;
  BackendTLSPolicy → service; **targetRef namespace defaulting** (omitted vs present);
  cross-namespace target; a non-matching target dropped silently.
- **fleet**: five-GVR dynamic fake assembling chips on gateway/route/service; a policy with two
  `targetRefs[]` fanning out to two nodes (sharing summary/details); **group-not-served →
  informational warning**; **served-but-list-fails (forbidden) → operational warning**; both
  distinct strings.
- **appbridge**: mapping incl. `details` rows, `target*` fields, and `service.policies`.
- **frontend**: chips on the three node types; header-once gateway chips; tooltip shows first 2-4
  details; detail panel "attached policies" section with target + features + rows.
- **Native handoff** (homelab-nelli, Envoy Gateway): real CTP/BTP/SP/EEP/BackendTLSPolicy land on
  the correct nodes, chips show feature presence, tooltips/detail show decoded values, YAML link
  opens the real object.

---

## Decisions log (M5-b-i additions to the parent spec)

| # | Decision | Why |
|---|----------|-----|
| 15 | Split M5-b: Envoy precise (b-i) before Cilium inferred (b-ii) | Same precise-vs-heuristic seam as the M5-a/M5-b split; native-verify clean targetRef attachment before the inferred pod heuristic |
| 16 | Five kinds: CTP/BTP/SP/EEP/BackendTLSPolicy, attached by targetRef | Covers the owner's Envoy Gateway edge (auth via EEP/SP, upstream TLS via BackendTLSPolicy); generic targetRef attach makes adding a kind cheap |
| 17 | Two-tier presentation: chip = feature presence, tooltip/detail = decoded values, YAML = truth | Keeps chips honest (can't misrepresent), still useful; resolves the decision-#13 tension over the "h2 16mb" example |
| 18 | `Summary` is value-free; `Details` carry values; `Target*` first-class | Discipline that stops future decoders getting clever; relationship metadata isn't a detail row |
| 19 | Per-kind decoder registry, not a generic spec-walker | A flattener produces noisy pseudo-YAML; explicit decoders give controlled, testable meaning with deterministic ordering |
| 20 | Two warning classes: group-not-served (informational) vs served-but-list-failed (operational) | RBAC reality — a forbidden list means the topology may be incomplete and the user must know; a missing CRD is just absence |
| 21 | `ServiceNode.Policies` (precise) kept separate from `ServiceNode.CNPs` (inferred) | Precise attachment and heuristic inference live in different buckets; M5-b-ii fills CNPs without touching Policies |
