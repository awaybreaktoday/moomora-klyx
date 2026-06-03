# Klyx Connection Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ClusterConn` resilient - a bounded connect timeout flips an unreachable cluster to `Failed`, informer watch errors flip a synced cluster to `Stale`, node/pod counts refresh live on watch events, and the cluster self-heals back to `Synced` when connectivity returns - all event-driven, no polling.

**Architecture:** Restructure `ClusterConn.Start` around client-go informer hooks. A bounded-retry connect goroutine owns the initial connect (and recovery-from-never-synced), running `Detect` before the first `EvSynced`. A refresh goroutine, fed by coalesced informer events, recomputes counts and recovers `Stale → Synced`. `SetWatchErrorHandler` drives `Synced → Stale`. The FSM gains one recovery edge.

**Tech Stack:** Go 1.22+, `k8s.io/client-go` (informers, metadata informers, `cache`), fakes: `client-go/kubernetes/fake`, `client-go/metadata/fake`, `client-go/testing`.

**Spec:** `docs/superpowers/specs/2026-06-03-klyx-connection-resilience-design.md`

**Files touched:** `internal/fleet/state.go` (+ test), `internal/fleet/conn.go` (+ test). No other packages change.

---

### Task 1: FSM recovery edge

Allow a successful sync to recover a `Failed` connection back to `Synced` (the `Stale → Synced` edge already exists).

**Files:**
- Modify: `internal/fleet/state.go`
- Test: `internal/fleet/state_test.go`

- [ ] **Step 1: Add the failing test cases**

Add these two test functions to `internal/fleet/state_test.go`:

```go
func TestRecoveryTransitions(t *testing.T) {
	cases := []struct {
		from ConnState
		ev   Event
		want ConnState
		ok   bool
	}{
		{Failed, EvSynced, Synced, true},  // recovery from never-synced/connect-timeout
		{Stale, EvSynced, Synced, true},   // recovery from a dropped watch
	}
	for _, tc := range cases {
		got, ok := Transition(tc.from, tc.ev)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Transition(%v,%v) = (%v,%v), want (%v,%v)",
				tc.from, tc.ev, got, ok, tc.want, tc.ok)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestRecoveryTransitions -v`
Expected: FAIL - `Transition(Failed,EvSynced)` currently returns `(Failed,false)`.

- [ ] **Step 3: Add the recovery edge**

In `internal/fleet/state.go`, the `Transition` function currently handles `EvStart` for the `Unconnected, Failed` case. Add an `EvSynced` recovery branch to the `Failed` and `Stale` states. Change the `case Unconnected, Failed:` block and the `case Stale:` block so the function reads:

```go
func Transition(from ConnState, ev Event) (ConnState, bool) {
	// A connection error is terminal-to-Failed from any connected state.
	if ev == EvConnError {
		return Failed, true
	}
	switch from {
	case Unconnected:
		if ev == EvStart {
			return Connecting, true
		}
	case Failed:
		switch ev {
		case EvStart:
			return Connecting, true
		case EvSynced:
			return Synced, true // recovery after a successful relist
		}
	case Connecting:
		if ev == EvSynced {
			return Synced, true
		}
	case Synced:
		switch ev {
		case EvCapUnhealthy:
			return Degraded, true
		case EvWatchDrop:
			return Stale, true
		}
	case Degraded:
		switch ev {
		case EvCapHealthy:
			return Synced, true
		case EvWatchDrop:
			return Stale, true
		}
	case Stale:
		if ev == EvSynced {
			return Synced, true
		}
	}
	return from, false
}
```

(Note: `Unconnected` and `Failed` are split into separate `case` blocks because `Failed` now also handles `EvSynced`. `Unconnected + EvSynced` must remain illegal, which the split preserves.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestRecoveryTransitions|TestTransitions' -v`
Expected: PASS (the new recovery cases AND the original `TestTransitions`, including the still-illegal `Unconnected + EvSynced`).

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/state.go internal/fleet/state_test.go
git commit -m "$(printf 'feat: FSM recovery edge (Failed/Stale + EvSynced -> Synced)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: ClusterConn fields and helpers

Add the connect-timeout knob, the coalescing refresh channel, and the two helper methods (`signalRefresh`, `onWatchError`). `onWatchError` is unit-tested directly by setting state in-package; `signalRefresh` is exercised in Task 3.

**Files:**
- Modify: `internal/fleet/conn.go`
- Test: `internal/fleet/conn_test.go`

- [ ] **Step 1: Add the failing test**

Add to `internal/fleet/conn_test.go` (add `"errors"` to its imports):

```go
func TestOnWatchErrorFromSyncedGoesStale(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, clock.Real{})
	c.state = Synced // in-package: drive directly without a live sync
	c.onWatchError(errors.New("boom"))
	s := c.Snapshot()
	if s.State != Stale {
		t.Fatalf("want Stale, got %v", s.State)
	}
	if s.Reason == "" {
		t.Fatal("watch error must set a reason")
	}
}

func TestOnWatchErrorIgnoredWhenNotSynced(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, clock.Real{})
	c.state = Connecting
	c.onWatchError(errors.New("boom"))
	if s := c.Snapshot(); s.State != Connecting {
		t.Fatalf("want Connecting unchanged, got %v", s.State)
	}
}

func TestNewClusterConnDefaultsConnectTimeout(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, clock.Real{})
	if c.connectTimeout != defaultConnectTimeout {
		t.Fatalf("want default connect timeout %v, got %v", defaultConnectTimeout, c.connectTimeout)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run 'TestOnWatchError|TestNewClusterConnDefaults' -v`
Expected: FAIL - `c.onWatchError` undefined, `c.connectTimeout`/`defaultConnectTimeout` undefined.

- [ ] **Step 3: Add the fields, constant, constructor init, and helpers**

In `internal/fleet/conn.go`:

a) Add the constant next to `defaultResync`:
```go
const defaultResync = 5 * time.Minute
const defaultConnectTimeout = 30 * time.Second
```

b) Add two fields to the `ClusterConn` struct (after `snapPods int`):
```go
	connectTimeout time.Duration
	refresh        chan struct{} // buffered(1); coalesces informer events
```

c) Initialise them in `NewClusterConn`:
```go
func NewClusterConn(name string, typed kubernetes.Interface, meta metadata.Interface,
	detector *capability.Detector, clk clock.Clock) *ClusterConn {
	return &ClusterConn{
		name: name, typed: typed, meta: meta, detector: detector, clk: clk,
		state:          Unconnected,
		connectTimeout: defaultConnectTimeout,
		refresh:        make(chan struct{}, 1),
	}
}
```

d) Add the two helper methods (place them after `setState`):
```go
// signalRefresh nudges the refresh loop without blocking. The buffered(1)
// channel coalesces bursts (e.g. the initial list of many pods) into one wake.
func (c *ClusterConn) signalRefresh() {
	select {
	case c.refresh <- struct{}{}:
	default:
	}
}

// onWatchError flips a synced connection to Stale when a list/watch fails.
// Pre-sync watch errors (state Connecting) are left to the connect-timeout
// path, so this is a no-op unless we are currently Synced or Degraded.
func (c *ClusterConn) onWatchError(err error) {
	c.mu.RLock()
	st := c.state
	c.mu.RUnlock()
	if st == Synced || st == Degraded {
		c.setState(EvWatchDrop, "watch error: "+err.Error())
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestOnWatchError|TestNewClusterConnDefaults' -v`
Expected: PASS (all three).

- [ ] **Step 5: Run the whole package and vet**

Run: `go test ./internal/fleet/ && go vet ./internal/fleet/`
Expected: all pass, vet clean. (`signalRefresh` is unused until Task 3 - Go does not flag unused methods, so this compiles.)

- [ ] **Step 6: Commit**

```bash
git add internal/fleet/conn.go internal/fleet/conn_test.go
git commit -m "$(printf 'feat: ClusterConn connect-timeout knob, refresh channel, watch-error helper\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Restructure Start (connect loop + watch-error + event-driven refresh)

Rewire `Start` to register the informer hooks before starting, run a bounded-retry connect goroutine, and a refresh goroutine. Replaces the current single startup goroutine.

**Files:**
- Modify: `internal/fleet/conn.go`
- Test: `internal/fleet/conn_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `internal/fleet/conn_test.go`. Add these imports if not present: `"strings"`, `k8stesting "k8s.io/client-go/testing"`, `"k8s.io/apimachinery/pkg/runtime"`, `"k8s.io/client-go/metadata"`.

```go
func TestConnectTimeoutGoesFailed(t *testing.T) {
	typed := fake.NewSimpleClientset()
	// Node list always errors, so the node informer never syncs.
	typed.PrependReactor("list", "nodes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("unreachable")
	})

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme)

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, det, clock.Real{})
	c.connectTimeout = 100 * time.Millisecond // in-package override for a fast test

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)

	waitFor(t, 3*time.Second, func() bool { return c.Snapshot().State == Failed })
	if r := c.Snapshot().Reason; !strings.Contains(r, "connect timed out") {
		t.Fatalf("want a connect-timeout reason, got %q", r)
	}
}

func TestWatchDrivenRefreshUpdatesPodCount(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
	)
	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme,
		podMeta("p1", "default"), podMeta("p2", "default"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, det, clock.Real{})
	c.Start(ctx)

	// Initial sync: 2 pods.
	waitFor(t, 2*time.Second, func() bool {
		s := c.Snapshot()
		return (s.State == Synced || s.State == Degraded) && s.Pods == 2
	})

	// A new pod appears -> watch ADD event -> coalesced refresh -> count updates.
	if err := mclient.Tracker().Add(podMeta("p3", "default")); err != nil {
		t.Fatalf("tracker add: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return c.Snapshot().Pods == 3 })
}
```

Note on `mclient.Tracker().Add(...)`: the metadata fake's object tracker fires a watch ADD that the metadata informer delivers to its event handler. If `Tracker()` or `Add` differs in the pinned client-go (v0.30.4), use the package's equivalent that triggers a watch event for `podGVR` in namespace `default` (e.g. `Tracker().Create(podGVR, obj, "default")`). The goal is a real watch event, not a store poke. Report which you used.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/fleet/ -run 'TestConnectTimeoutGoesFailed|TestWatchDrivenRefresh' -v`
Expected: FAIL - the current `Start` blocks indefinitely on the unreachable cluster (no timeout) and never refreshes counts after the initial sync.

- [ ] **Step 3: Replace Start and add connectLoop + refreshLoop**

In `internal/fleet/conn.go`, replace the entire existing `Start` function (and its trailing startup goroutine) with the following, and add the two new methods. Keep `capabilityReason` and `refreshCounts` exactly as they are.

```go
// Start launches the eager-set informers, wiring watch-error and event handlers
// before start, then runs the connect and refresh goroutines. All three loops
// are bound to ctx; the informers retry in the background, so a connection that
// fails to sync within connectTimeout is marked Failed but self-heals to Synced
// when a later relist succeeds.
func (c *ClusterConn) Start(ctx context.Context) {
	c.setState(EvStart, "")

	nodeFactory := informers.NewSharedInformerFactory(c.typed, defaultResync)
	nodeInformer := nodeFactory.Core().V1().Nodes().Informer()

	metaFactory := metadatainformer.NewSharedInformerFactory(c.meta, defaultResync)
	podInformer := metaFactory.ForResource(podGVR).Informer()

	// Register handlers BEFORE starting the informers. SetWatchErrorHandler
	// errors only if called after Start, which we do not do; ignore defensively.
	for _, inf := range []cache.SharedIndexInformer{nodeInformer, podInformer} {
		_ = inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
			c.onWatchError(err)
		})
		_, _ = inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(interface{}) { c.signalRefresh() },
			UpdateFunc: func(interface{}, interface{}) { c.signalRefresh() },
			DeleteFunc: func(interface{}) { c.signalRefresh() },
		})
	}

	nodeFactory.Start(ctx.Done())
	metaFactory.Start(ctx.Done())

	go c.refreshLoop(ctx, nodeInformer, podInformer)
	go c.connectLoop(ctx, nodeInformer, podInformer)
}

// connectLoop owns the initial connect. It bounds each sync attempt by
// connectTimeout; on success it runs detection and announces Synced (this is the
// only place the first EvSynced is emitted, so Detect always precedes it). On
// timeout it marks Failed and retries, so a never-synced cluster self-heals to
// Synced (Failed -> Synced) once connectivity returns.
func (c *ClusterConn) connectLoop(ctx context.Context, nodeInformer, podInformer cache.SharedIndexInformer) {
	for {
		tctx, cancel := context.WithTimeout(ctx, c.connectTimeout)
		ok := cache.WaitForCacheSync(tctx.Done(), nodeInformer.HasSynced, podInformer.HasSynced)
		cancel()

		if ctx.Err() != nil {
			return // parent cancelled
		}
		if ok {
			caps := c.detector.Detect(ctx)

			c.mu.Lock()
			c.caps = caps
			c.mu.Unlock()

			c.refreshCounts(nodeInformer, podInformer)
			c.setState(EvSynced, "")

			// Capability health is evaluated once at startup. Re-evaluation (and
			// the EvCapHealthy transition back to Synced) is deferred to a later
			// slice, including re-applying this overlay after a recovery.
			if caps.GitOps.Tier == capability.Degraded || caps.Network.Tier == capability.Degraded {
				c.setState(EvCapUnhealthy, capabilityReason(caps))
			}
			return
		}
		c.setState(EvConnError, "connect timed out after "+c.connectTimeout.String())
	}
}

// refreshLoop recomputes counts on coalesced informer events for the lifetime of
// ctx. It does not drive the initial Connecting -> Synced (connectLoop owns that,
// to avoid racing ahead of Detect). It does recover Stale -> Synced when a relist
// resumes after a dropped watch.
func (c *ClusterConn) refreshLoop(ctx context.Context, nodeInformer, podInformer cache.SharedIndexInformer) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.refresh:
			if !nodeInformer.HasSynced() || !podInformer.HasSynced() {
				continue
			}
			c.refreshCounts(nodeInformer, podInformer)

			c.mu.RLock()
			st := c.state
			c.mu.RUnlock()
			if st == Stale {
				c.setState(EvSynced, "")
			}
		}
	}
}
```

Also update the doc comment on `refreshCounts`: it is no longer "called once" - change its leading comment to:
```go
// refreshCounts recomputes node/pod counts and lastSync from the informer
// stores. Called by connectLoop on initial sync and by refreshLoop on every
// coalesced watch event.
```

- [ ] **Step 4: Run the new tests**

Run: `go test ./internal/fleet/ -run 'TestConnectTimeoutGoesFailed|TestWatchDrivenRefresh' -v`
Expected: PASS. If `TestWatchDrivenRefresh` fails on `mclient.Tracker()`, apply the metadata-fake fallback noted in Step 1 and re-run.

- [ ] **Step 5: Run the whole package under the race detector, repeatedly**

Run: `go test -race -count=5 ./internal/fleet/`
Expected: all pass across 5 runs, no race. (Confirms connectLoop and refreshLoop calling `refreshCounts`/`setState` concurrently are correctly serialised by `c.mu`.)

- [ ] **Step 6: Run vet and the full repo suite**

Run: `go vet ./... && go test ./... -count=1`
Expected: vet clean; all packages pass.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/conn.go internal/fleet/conn_test.go
git commit -m "$(printf 'feat: bounded connect, watch-error Stale, event-driven count refresh, self-heal\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage (against `2026-06-03-klyx-connection-resilience-design.md`):**

- 2.1 / 3.2 event-driven (no polling): `AddEventHandler` + `SetWatchErrorHandler`, no ticker → Tasks 2-3. ✓
- 2.2 / 3.1 self-healing recovery: FSM `Failed+EvSynced` and `Stale+EvSynced` → Task 1; connectLoop retry (Failed→Synced) and refreshLoop (Stale→Synced) → Task 3. ✓
- 2.3 capability re-eval deferred: documented in the connectLoop comment; recovery does not re-run Detect → Task 3. ✓
- 3.2 connectTimeout unexported field, default 30s, in-package test override: Task 2 (field/default/test) + Task 3 (used, overridden in timeout test). ✓
- 3.2 coalescing buffered(1) refresh channel: Task 2 (field + signalRefresh) + Task 3 (handlers feed it, refreshLoop drains). ✓
- 3.2 onWatchError only acts when Synced/Degraded: Task 2 (impl + both tests). ✓
- 3.2 connect loop bounded + does not stop informers + self-heals: Task 3 connectLoop. ✓
- 4 tests: FSM recovery (Task 1), connect timeout (Task 3), watch-drop→Stale via onWatchError (Task 2), watch-driven refresh (Task 3), `-race -count=5` (Task 3 Step 5). ✓

**Placeholder scan:** none. The one conditional is Task 3 Step 1's documented `Tracker()` fallback for client-go version drift - an explicit alternative with a stated goal, not a placeholder (same pattern that worked for the metadata-fake scheme in the foundation plan).

**Type consistency:** `connectTimeout`/`refresh`/`defaultConnectTimeout` defined in Task 2 are used in Task 3. `signalRefresh`/`onWatchError` defined in Task 2 are wired in Task 3. `connectLoop`/`refreshLoop` are new in Task 3 and consume the existing `refreshCounts`, `setState`, `capabilityReason`, `podGVR`, `defaultResync`, `Detect`, and `capability.Degraded` - all already present from the foundation. FSM `Failed+EvSynced→Synced` (Task 1) is what connectLoop's recovery emit relies on (Task 3). Consistent.
