# Klyx connection resilience design (bounded connect + watch-driven refresh + self-heal)

Date: 2026-06-03
Status: approved design, ready for plan
Scope: a focused data-layer slice hardening `internal/fleet/ClusterConn`. Builds on
the M1 data foundation (`2026-06-03-klyx-foundation-design.md`). No UI, no metrics.

## 1. Context and problem

`ClusterConn.Start` currently blocks the startup goroutine on
`cache.WaitForCacheSync(ctx.Done(), ...)`, which only unblocks when the parent
context is cancelled. Consequences observed via `klyxctl`:

- An unreachable cluster sits in `Connecting` indefinitely instead of reporting
  `Failed` - there is no bounded connect timeout.
- Node/pod counts are computed exactly once after the initial sync
  (`refreshCounts` is one-shot), so they drift as the cluster changes.
- A watch that drops mid-session is never surfaced as `Stale`; the FSM has the
  `EvWatchDrop` event but nothing emits it.

The connection FSM (`state.go`) already models `Stale`, `Failed`, `EvWatchDrop`,
and `EvConnError`. This slice wires the live signals that drive them, and adds a
recovery edge so a long-lived desktop app self-heals after transient outages
(VPN blips) without a restart.

## 2. Decisions taken

1. **Event-driven, not polled.** Use client-go informer hooks
   (`SetWatchErrorHandler`, `AddEventHandler`) rather than a ticker. This honours
   the project principle that client-go is watch-based and never polled.
2. **Self-healing recovery.** Informers run on the parent context and keep
   retrying. A connect timeout marks the cluster `Failed` but does not stop the
   informers; when connectivity returns and a relist succeeds, the cluster
   transitions back to `Synced` automatically. A dropped watch flips to `Stale`
   and recovers the same way.
3. **Capability re-evaluation stays deferred.** On recovery the cluster returns
   to `Synced` and refreshes counts, but `Detect` is NOT re-run, so a previously
   `Degraded` capability overlay is not re-applied until the separate
   capability-re-evaluation slice. Documented in code.

## 3. Design

### 3.1 FSM recovery edge (`internal/fleet/state.go`)

Add a recovery transition: `EvSynced` transitions to `Synced` from `Failed` as
well as from the existing `Connecting` and `Stale`. `EvConnError` continues to
win to `Failed` from any state. This is the only `state.go` change.

Resulting relevant transitions:
- `Connecting + EvSynced -> Synced`
- `Stale + EvSynced -> Synced` (recovery)
- `Failed + EvSynced -> Synced` (recovery) - NEW
- `{Synced,Degraded} + EvWatchDrop -> Stale`
- any `+ EvConnError -> Failed`

### 3.2 ClusterConn restructure (`internal/fleet/conn.go`)

- Add an unexported field `connectTimeout time.Duration`, defaulted to 30s in
  `NewClusterConn`. In-package tests set it directly (e.g. 100ms). The exported
  `NewClusterConn` signature is unchanged, so the factory and existing tests are
  untouched.
- Add a buffered(1) `refresh chan struct{}` used to coalesce informer events.

`Start` becomes:
1. Build node and pod informers (as today).
2. BEFORE starting them, on BOTH informers:
   - `SetWatchErrorHandler(...)` -> calls unexported `c.onWatchError(err)`.
   - `AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc, UpdateFunc,
     DeleteFunc})` -> each calls `c.signalRefresh()` (non-blocking send to the
     buffered channel).
   Note: `SetWatchErrorHandler` must be called before the informer starts and
   returns an error if called after; handle/ignore that error defensively.
3. Start both informers on the parent `ctx`.
4. Launch the connect goroutine - a bounded-retry loop that exclusively owns the
   initial connect (so `Detect` always runs before the first `EvSynced`, and a
   never-synced cluster that later recovers still gets a first `Detect`):
   ```
   for {
       tctx, cancel := context.WithTimeout(ctx, c.connectTimeout)
       ok := cache.WaitForCacheSync(tctx.Done(), nodeInformer.HasSynced, podInformer.HasSynced)
       cancel()
       if ctx.Err() != nil { return }          // parent cancelled - stop
       if ok {
           caps := c.detector.Detect(ctx)
           // store caps under lock; refreshCounts; EvSynced;
           // if a tier is Degraded, EvCapUnhealthy
           return                                // initial connect done
       }
       // timed out (parent still alive): mark Failed, keep looping.
       // Informers were started on the parent ctx and keep retrying, so a later
       // iteration's WaitForCacheSync succeeds and this loop self-heals
       // Failed -> Synced via the EvSynced above.
       c.setState(EvConnError, "connect timed out after " + c.connectTimeout.String())
   }
   ```
   Each failed iteration blocks up to `connectTimeout` inside `WaitForCacheSync`
   (which polls `HasSynced` internally), so the loop does not hot-spin.
5. Launch the refresh goroutine (`c.refreshLoop(ctx, nodeInformer, podInformer)`):
   drains `refresh`; on each coalesced signal, if both informers `HasSynced()`,
   recompute counts via `refreshCounts`. It does NOT drive the initial
   `Connecting -> Synced` (the connect goroutine owns that, to avoid racing ahead
   of `Detect`). It DOES handle post-drop recovery: if the current state is
   `Stale`, emit `EvSynced` (`Stale -> Synced`).

Helpers:
- `c.signalRefresh()`: non-blocking `select { case c.refresh <- struct{}{}: default: }`.
- `c.onWatchError(err error)`: if current state is `Synced` or `Degraded`, emit
  `EvWatchDrop` with reason `"watch error: <err>"`. (Pre-sync watch errors are
  left to the connect-timeout path; `onWatchError` is a no-op then.)

Lock discipline unchanged: all shared field access stays under the existing
`sync.RWMutex`; `setState` and `refreshCounts` already lock.

### 3.3 Files touched

- `internal/fleet/state.go` (+ test) - recovery edge.
- `internal/fleet/conn.go` (+ test) - restructure, timeout, handlers, refresh
  loop, `onWatchError`, `signalRefresh`.

No other packages change. `Snapshot`, `Registry`, `aggregate`, `factory`,
`capability` are untouched.

## 4. Testing

- **FSM** (`state_test.go`): add cases `Failed + EvSynced -> Synced (ok)` and
  confirm `Stale + EvSynced -> Synced (ok)`.
- **Connect timeout** (`conn_test.go`): fake typed clientset with a
  `PrependReactor("list", "nodes", ...)` (and pods) returning an error so the
  informer never syncs; set `conn.connectTimeout = 100ms`; assert state becomes
  `Failed` with a reason containing "connect timed out".
- **Watch-drop** (`conn_test.go`): drive a conn to `Synced`, call
  `conn.onWatchError(errors.New("boom"))` directly, assert state `Stale` with a
  reason containing "watch error".
- **Watch-driven refresh** (`conn_test.go`): sync with 2 pods, then
  `Create` a third `PartialObjectMetadata` pod on the fake metadata client; poll
  `Snapshot().Pods` until it reaches 3 (proves the AddEventHandler -> refresh
  path works against a live watch event).
- All existing fleet/`-race` tests must still pass; run `go test -race -count=5
  ./internal/fleet/` to confirm no flakiness in the new concurrency.

## 5. Out of scope (unchanged deferrals)

- Capability re-evaluation on recovery (`EvCapHealthy` / re-running `Detect`).
- Metrics/PromQL client.
- Manual user-triggered reconnect UI.
- Plan B (Wails shell + fleet view).

## 6. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Event-driven via informer hooks, no polling | Project principle: watch-based, never polled |
| 2 | Self-healing recovery (Failed/Stale -> Synced) | Long-lived desktop app; VPN blips must not need a restart |
| 3 | `connectTimeout` unexported field, default 30s | Testable (in-package tests set 100ms) without changing NewClusterConn signature |
| 4 | Coalescing buffered(1) refresh channel | Avoid O(n) recomputes during large initial list bursts |
| 5 | Capability re-evaluation stays deferred | Keeps slice focused; separate concern |
