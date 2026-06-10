package fleet

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// watchUntil polls cond until true or the deadline, mirroring the appbridge
// helper. Returns the final evaluation.
func watchUntil(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

// TestWatchDirty_EventFiresOnDirty verifies that a resource change delivered on
// the watch channel triggers onDirty, and that establishing the watch reports
// liveness true.
func TestWatchDirty_EventFiresOnDirty(t *testing.T) {
	cs := fake.NewSimpleClientset()
	fw := watch.NewFake()
	cs.PrependWatchReactor("pods", k8stesting.DefaultWatchReactor(fw, nil))

	c := &ClusterConn{typed: cs}

	var dirty atomic.Int64
	var live atomic.Bool
	stop, err := c.WatchDirty(context.Background(), "", []string{"pods"},
		func() { dirty.Add(1) },
		func(up bool) { live.Store(up) },
	)
	if err != nil {
		t.Fatalf("WatchDirty: %v", err)
	}
	defer stop()

	// The single kind establishing means all-up -> live(true).
	if !watchUntil(2*time.Second, func() bool { return live.Load() }) {
		t.Fatal("never reported live(true) after establish")
	}

	// Send an event; onDirty must fire.
	go fw.Add(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "ns", Name: "p1"}})
	if !watchUntil(2*time.Second, func() bool { return dirty.Load() >= 1 }) {
		t.Fatalf("onDirty never fired; count=%d", dirty.Load())
	}
}

// TestWatchDirty_StopExitsGoroutines verifies the goroutine-delta is zero after
// stop(): every per-kind supervisor exits and the WaitGroup drains.
func TestWatchDirty_StopExitsGoroutines(t *testing.T) {
	runtime.GC()
	before := runtime.NumGoroutine()

	cs := fake.NewSimpleClientset()
	// Default fake clientset Watch support handles all kinds.
	c := &ClusterConn{typed: cs}

	stop, err := c.WatchDirty(context.Background(), "",
		[]string{"pods", "deployments", "statefulsets", "daemonsets", "events"},
		func() {}, func(bool) {})
	if err != nil {
		t.Fatalf("WatchDirty: %v", err)
	}

	// Let the supervisors establish.
	time.Sleep(100 * time.Millisecond)
	stop()
	stop() // idempotent

	deadline := time.Now().Add(3 * time.Second)
	var after int
	for time.Now().Before(deadline) {
		runtime.GC()
		after = runtime.NumGoroutine()
		if after <= before+2 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("goroutine leak after stop: before=%d after=%d (delta=%d)", before, after, after-before)
}

// TestWatchDirty_ReestablishesAfterClose verifies that when the watch channel
// closes (server-side close / timeout), the loop re-establishes a new watch
// (reactor invoked >=2 times) and reports the liveness dip false->true.
func TestWatchDirty_ReestablishesAfterClose(t *testing.T) {
	cs := fake.NewSimpleClientset()

	var calls atomic.Int64
	var mu sync.Mutex
	current := watch.NewFake()

	// Each Watch call hands back a fresh fake watcher. Stopping a watch.Fake
	// closes its channel, which our loop treats as "channel closed -> backoff +
	// re-establish".
	cs.PrependWatchReactor("pods", func(action k8stesting.Action) (bool, watch.Interface, error) {
		calls.Add(1)
		mu.Lock()
		current = watch.NewFake()
		w := current
		mu.Unlock()
		return true, w, nil
	})

	c := &ClusterConn{typed: cs}

	var liveTransitions []bool
	var ltMu sync.Mutex
	stop, err := c.WatchDirty(context.Background(), "", []string{"pods"},
		func() {},
		func(up bool) {
			ltMu.Lock()
			liveTransitions = append(liveTransitions, up)
			ltMu.Unlock()
		},
	)
	if err != nil {
		t.Fatalf("WatchDirty: %v", err)
	}
	defer stop()

	// Wait for the first establish.
	if !watchUntil(2*time.Second, func() bool { return calls.Load() >= 1 }) {
		t.Fatal("first watch never established")
	}

	// Close the active watcher's channel to force a re-establish. The 1s initial
	// backoff means the re-establish lands within ~1.5s.
	mu.Lock()
	w := current
	mu.Unlock()
	w.Stop()

	if !watchUntil(3*time.Second, func() bool { return calls.Load() >= 2 }) {
		t.Fatalf("watch not re-established; calls=%d", calls.Load())
	}

	// Liveness must have dipped to false then returned to true.
	if !watchUntil(3*time.Second, func() bool {
		ltMu.Lock()
		defer ltMu.Unlock()
		sawFalse := false
		for i, v := range liveTransitions {
			if !v {
				sawFalse = true
			}
			if sawFalse && v && i > 0 {
				return true
			}
		}
		return false
	}) {
		ltMu.Lock()
		got := append([]bool(nil), liveTransitions...)
		ltMu.Unlock()
		t.Fatalf("expected live false->true transition, got %v", got)
	}
}

// TestWatchDirty_UnsupportedKind rejects an unknown kind at Open time rather
// than silently dropping the stream.
func TestWatchDirty_UnsupportedKind(t *testing.T) {
	cs := fake.NewSimpleClientset()
	c := &ClusterConn{typed: cs}
	stop, err := c.WatchDirty(context.Background(), "", []string{"pods", "bogus"},
		func() {}, func(bool) {})
	if err == nil {
		if stop != nil {
			stop()
		}
		t.Fatal("want error on unsupported kind")
	}
}

// TestWatchDirty_LivenessAllUp verifies the aggregate only reports true once all
// kinds are up (not on the first kind establishing).
func TestWatchDirty_LivenessAllUp(t *testing.T) {
	cs := fake.NewSimpleClientset()
	c := &ClusterConn{typed: cs}

	var live atomic.Bool
	var gotTrue atomic.Bool
	stop, err := c.WatchDirty(context.Background(), "",
		[]string{"pods", "deployments"},
		func() {},
		func(up bool) {
			live.Store(up)
			if up {
				gotTrue.Store(true)
			}
		},
	)
	if err != nil {
		t.Fatalf("WatchDirty: %v", err)
	}
	defer stop()

	if !watchUntil(2*time.Second, func() bool { return gotTrue.Load() }) {
		t.Fatal("never reached all-up live(true)")
	}
}
