# Klyx capability health watch design (live GitOps controller health)

Date: 2026-06-03
Status: approved design, ready for plan
Scope: a data-layer slice making GitOps capability health live/event-driven.
Builds on the M1 foundation and the connection-resilience slice. No UI, no metrics.

## 1. Context and problem

`capability.Detect` runs once at connect: it reads the discovery API (presence,
API versions) and does a one-shot read of the GitOps controller workloads to
classify the GitOps tier (Healthy/Degraded). After that, capability health is
frozen. A `kustomize-controller` that starts crashlooping after the initial
Healthy detection is not reflected until a full reconnect. The FSM defines
`EvCapHealthy` (Degraded -> Synced) but nothing ever emits it.

This slice makes GitOps controller health live and event-driven, finally
exercising both `EvCapUnhealthy` and `EvCapHealthy`, and closing the deferred
"capability re-evaluation on recovery" gap as a side effect.

## 2. Scope boundary (decisions taken)

Split the capability surface by what is volatile and watchable:

1. **Presence** (served CRDs/API groups, Gateway API version) comes from the
   discovery API, which is NOT watchable, and changes only on install/uninstall.
   Presence stays detected at connect. A genuine install/uninstall mid-session is
   a documented non-goal (a reconnect/restart re-detects it).
2. **GitOps controller health** (`kustomize-controller` Deployment in
   `flux-system`; `argocd-application-controller` StatefulSet in `argocd`) is the
   volatile signal and is a workload readiness - watchable. THIS is what we
   watch, driving GitOps `Healthy <-> Degraded` reactively.
3. **Network capability health** is presence-based in the current detector
   (Gateway API present AND EnvoyProxy CRD present), not a running-controller
   check, so it rides with presence at connect. Not watched.

Only the official install-default namespaces/names are supported (already a
documented limitation in the detector).

## 3. Design

### 3.1 `internal/capability` changes (additive + two internal extractions, all pure)

One source of truth for "what makes GitOps Healthy vs Degraded", shared by the
initial `Detect` and the live monitor:

- Extract readiness helpers from `controllerHealthy`:
  ```go
  func DeploymentReady(d *appsv1.Deployment) bool   // AvailableReplicas >= desired (default 1)
  func StatefulSetReady(s *appsv1.StatefulSet) bool // ReadyReplicas >= desired (default 1)
  ```
  `controllerHealthy` is rewritten to use them.
- Extract the tier computation from `detectGitOps`:
  ```go
  func gitOpsTier(flux FluxInfo, argo ArgoInfo) (Tier, string)
  ```
  `detectGitOps` and the monitor both use it.
- Expose the workloads to watch:
  ```go
  type ControllerRef struct {
      Tool      string // "flux" | "argo"
      Kind      string // "Deployment" | "StatefulSet"
      Namespace string
      Name      string
  }
  func ControllerRefs(s Set) []ControllerRef
  ```
  flux present -> Deployment `kustomize-controller`/`flux-system`; argo present ->
  StatefulSet `argocd-application-controller`/`argocd`; empty if neither. `Kind`
  is a plain string so the unexported `workloadKind` enum stays internal.
- Recompute on a health change:
  ```go
  func WithGitOpsHealth(s Set, fluxHealthy, argoHealthy bool) GitOpsCapability
  ```
  Returns a new `GitOpsCapability` preserving presence/version/coexistence but
  recomputing tier + reason + `Healthy` flags from fresh readiness via
  `gitOpsTier`. Readiness args are only consulted for tools that are present.

`Detect`'s external behavior is unchanged - it still returns the presence +
initial-health snapshot used at connect.

### 3.2 `internal/fleet/caphealth.go` (new) - the monitor

```go
type capHealth struct {
    set     capability.Set
    fluxInf cache.SharedIndexInformer // nil if Flux absent
    argoInf cache.SharedIndexInformer // nil if Argo absent
    apply   func(capability.GitOpsCapability) // conn callback
}
```

`startCapHealth(ctx, set)` (a `ClusterConn` method): for each
`capability.ControllerRefs(set)`, start a namespace-scoped, name-filtered
informer (`informers.NewSharedInformerFactoryWithOptions` with
`informers.WithNamespace(ref.Namespace)` and `WithTweakListOptions` setting
`metadata.name=<ref.Name>`) on the Deployment or StatefulSet. Register one
`ResourceEventHandlerFuncs` (Add/Update/Delete) that recomputes from the stores
(no shared mutable readiness flags - compute from source each event):
read each present tool's workload from its informer store, apply
`DeploymentReady`/`StatefulSetReady`, then
`g := capability.WithGitOpsHealth(set, fluxHealthy, argoHealthy)` and `apply(g)`.
Start the factories on the parent ctx so they retry/relist like the eager set.

If `ControllerRefs(set)` is empty (no GitOps tool present), `startCapHealth` is a
no-op.

### 3.3 `internal/fleet/conn.go` - two touches

1. In `connectLoop`'s success branch, after the initial detect and `EvSynced`
   (and the existing initial `EvCapUnhealthy`), call `c.startCapHealth(ctx, caps)`.
   The initial one-shot tier from `Detect` gives an immediate correct tier; the
   monitor maintains it thereafter.
2. Add `applyGitOpsHealth`, updating caps + driving the FSM atomically under one
   lock using the pure `Transition`:
   ```go
   func (c *ClusterConn) applyGitOpsHealth(g capability.GitOpsCapability) {
       var ev Event
       switch g.Tier {
       case capability.Degraded:
           ev = EvCapUnhealthy
       case capability.Healthy:
           ev = EvCapHealthy
       default: // Absent: should not occur for a present tool
           c.mu.Lock()
           c.caps.GitOps = g
           c.mu.Unlock()
           return
       }
       c.mu.Lock()
       c.caps.GitOps = g
       if next, ok := Transition(c.state, ev); ok {
           c.state = next
           c.reason = g.Reason // clears on Healthy (g.Reason == ""), sets on Degraded
       }
       c.mu.Unlock()
   }
   ```

### 3.4 FSM interaction (no FSM change)

- `Synced + EvCapUnhealthy -> Degraded`; `Degraded + EvCapHealthy -> Synced`
  (both already exist). This slice is the first to fire `EvCapHealthy`.
- While `Connecting`/`Stale`/`Failed`, a health event updates `caps.GitOps` but
  the transition is a no-op (`Transition` returns false) - safe by construction.
- Recovery reasserts health automatically: on a blip the controller informer's
  watch also drops and relists; the relist fires events, so once the cluster is
  back to `Synced` (via `refreshLoop`), the monitor re-applies the current tier -
  a still-crashlooping controller re-flips it to `Degraded`. No recovery-specific
  code.

Cost: +1 informer for Flux-only clusters, +2 if both tools present, each scoped
to a single named workload in one namespace. Negligible.

## 4. Testing

### 4.1 `internal/capability` (pure)
- `DeploymentReady`/`StatefulSetReady`: ready when Available/Ready replicas >=
  desired (incl. nil-`Replicas` default of 1), not-ready below.
- `ControllerRefs`: Flux-only -> one Deployment ref; Argo-only -> one StatefulSet
  ref; both -> two; neither -> empty.
- `WithGitOpsHealth`: present+healthy -> Healthy; present+unhealthy -> Degraded
  with non-empty reason; coexistence/version preserved; flipping `argoHealthy`
  false while `fluxHealthy` true degrades the combined tier.

### 4.2 `internal/fleet/caphealth_test.go` (live integration - the payoff)
- Fake typed clientset: Flux CRD served (discovery), a healthy
  `kustomize-controller` Deployment (`AvailableReplicas=1`), a ready node; a
  metadata fake with a couple of pods.
- `Start` the conn; `waitFor` `Synced` with `GitOps.Tier == Healthy`.
- Degrade live: `typed.Tracker().Update(...)` the Deployment to
  `AvailableReplicas=0` (fires a watch event); `waitFor` `State == Degraded` and
  `GitOps.Tier == Degraded` with a reason. Exercises `EvCapUnhealthy` reactively.
- Heal live: update back to `AvailableReplicas=1`; `waitFor` `State == Synced`,
  `GitOps.Tier == Healthy`, reason cleared. Exercises `EvCapHealthy` - the edge
  nothing has fired until now.
- `go test -race -count=5 ./internal/fleet/`.

If `Tracker().Update` does not fire a watch update in client-go v0.30.4, use the
package's equivalent that delivers a watch MODIFY event for the Deployment.

### 4.3 Regression
All existing fleet/capability tests still pass; the `Detect` refactor and the new
monitor must not disturb connect/snapshot/resilience behavior.

## 5. Out of scope (documented)

- Presence re-detection mid-session (install/uninstall) - reconnect/restart only.
- Network/non-GitOps capability health watching (presence-based today).
- Metrics/PromQL client; Plan B (Wails shell + fleet view).

## 6. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Event-driven health watch (purest option) | Live, principled, no polling |
| 2 | Watch GitOps controller workloads only | The only volatile, watchable health signal |
| 3 | Presence stays connect-time (discovery unwatchable) | Discovery is not a watch; presence is stable intra-session |
| 4 | New `caphealth.go` unit | Keeps conn.go about lifecycle; monitor independently testable |
| 5 | `applyGitOpsHealth` manages caps+state+reason under one lock | Atomic, reuses pure Transition, clears reason on heal |
| 6 | Recompute from informer stores each event | No shared mutable readiness flags; one source of truth |
