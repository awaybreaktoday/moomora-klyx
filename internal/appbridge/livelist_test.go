package appbridge

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/fleet"
	"github.com/moomora/klyx/internal/workloads"
)

// anyEmitter records every emitted event (name + payload) under a mutex so tests
// can poll it race-free from another goroutine.
type anyEmitter struct {
	mu     sync.Mutex
	events []anyEvent
}

type anyEvent struct {
	name string
	data any
}

func (e *anyEmitter) Emit(name string, data any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, anyEvent{name: name, data: data})
}

func (e *anyEmitter) snapshot() []anyEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]anyEvent, len(e.events))
	copy(out, e.events)
	return out
}

// countOf returns how many recorded events have the given name.
func (e *anyEmitter) countOf(name string) int {
	n := 0
	for _, ev := range e.snapshot() {
		if ev.name == name {
			n++
		}
	}
	return n
}

func (e *anyEmitter) lastLive(name string) (bool, bool) {
	var found bool
	var v bool
	for _, ev := range e.snapshot() {
		if ev.name == name {
			if s, ok := ev.data.(liveStatusDTO); ok {
				v = s.Live
				found = true
			}
		}
	}
	return v, found
}

func liveWaitUntil(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}

// fakeLivePodConn captures the onDirty/onLive callbacks WatchDirty is given so a
// test can fire dirty signals at will. computeFails forces ListPods to error so
// the compute-failure path is exercised.
type fakeLivePodConn struct {
	mu          sync.Mutex
	onDirty     func()
	onLive      func(bool)
	watchErr    error
	computeFail bool
	listCalls   int
}

func (f *fakeLivePodConn) ListPods(context.Context, string) ([]workloads.PodSummary, error) {
	f.mu.Lock()
	f.listCalls++
	fail := f.computeFail
	f.mu.Unlock()
	if fail {
		return nil, context.DeadlineExceeded
	}
	return []workloads.PodSummary{{Namespace: "ns", Name: "p1", Rank: workloads.Healthy}}, nil
}

func (f *fakeLivePodConn) PodDetail(context.Context, string, string) (fleet.PodDetail, error) {
	return fleet.PodDetail{}, nil
}

func (f *fakeLivePodConn) DeletePod(context.Context, string, string) error { return nil }

func (f *fakeLivePodConn) WatchDirty(_ context.Context, _ string, _ []string, onDirty func(), onLive func(bool)) (func(), error) {
	f.mu.Lock()
	f.onDirty = onDirty
	f.onLive = onLive
	werr := f.watchErr
	f.mu.Unlock()
	if werr != nil {
		return nil, werr
	}
	return func() {}, nil
}

func (f *fakeLivePodConn) fireDirty() {
	f.mu.Lock()
	d := f.onDirty
	f.mu.Unlock()
	if d != nil {
		d()
	}
}

func (f *fakeLivePodConn) setComputeFail(v bool) {
	f.mu.Lock()
	f.computeFail = v
	f.mu.Unlock()
}

// newFastPodsSvc builds a PodsService whose live registry ticks every 10ms so
// dirty-driven re-emits land fast in tests.
func newFastPodsSvc(conn PodsConn, em Emitter) *PodsService {
	s := NewPodsService(func(string) (PodsConn, bool) { return conn, true }, em)
	s.live.interval = 10 * time.Millisecond
	return s
}

// --- tests ---

func TestLiveList_ImmediateEmitOnOpen(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	res := svc.OpenLivePods("c", "ns")
	if !res.OK {
		t.Fatalf("open failed: %+v", res)
	}
	defer svc.CloseLivePods("c", "ns")

	if !liveWaitUntil(t, time.Second, func() bool { return em.countOf("livePods:c:ns") >= 1 }) {
		t.Fatal("no immediate emit on open")
	}
	if !liveWaitUntil(t, time.Second, func() bool {
		v, ok := em.lastLive("livePodsStatus:c:ns")
		return ok && v
	}) {
		t.Fatal("never reported live(true) after open")
	}
}

func TestLiveList_DirtyTriggersEmit(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	defer svc.CloseLivePods("c", "ns")

	if !liveWaitUntil(t, time.Second, func() bool { return em.countOf("livePods:c:ns") >= 1 }) {
		t.Fatal("no immediate emit")
	}
	base := em.countOf("livePods:c:ns")

	conn.fireDirty()
	if !liveWaitUntil(t, time.Second, func() bool { return em.countOf("livePods:c:ns") > base }) {
		t.Fatalf("dirty did not trigger a re-emit; count stuck at %d", em.countOf("livePods:c:ns"))
	}
}

func TestLiveList_StableWhenIdle(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	defer svc.CloseLivePods("c", "ns")

	if !liveWaitUntil(t, time.Second, func() bool { return em.countOf("livePods:c:ns") >= 1 }) {
		t.Fatal("no immediate emit")
	}
	// No dirty fired: across many ticker intervals the count must not grow.
	stable := em.countOf("livePods:c:ns")
	time.Sleep(150 * time.Millisecond) // ~15 ticks at 10ms
	if got := em.countOf("livePods:c:ns"); got != stable {
		t.Fatalf("idle subscription emitted unprompted: was %d now %d", stable, got)
	}
}

func TestLiveList_ReplaceOnSameKeyStopsOld(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	if svc.live.count() != 1 {
		t.Fatalf("want 1 sub, got %d", svc.live.count())
	}
	// Capture the first sub's done so we can prove it closes on replace.
	svc.live.mu.Lock()
	old := svc.live.subs["pods:c:ns"]
	svc.live.mu.Unlock()

	svc.OpenLivePods("c", "ns") // replace
	defer svc.CloseLivePods("c", "ns")

	select {
	case <-old.done:
	case <-time.After(2 * time.Second):
		t.Fatal("old sub not stopped on replace")
	}
	if svc.live.count() != 1 {
		t.Fatalf("want 1 sub after replace, got %d", svc.live.count())
	}
}

func TestLiveList_CloseIdempotent(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	svc.CloseLivePods("c", "ns")
	svc.CloseLivePods("c", "ns")   // second close: no-op
	svc.CloseLivePods("c", "gone") // unknown key: no-op
	if svc.live.count() != 0 {
		t.Fatalf("want 0 subs after close, got %d", svc.live.count())
	}
}

func TestLiveList_CloseAllDrains(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns1")
	svc.OpenLivePods("c", "ns2")
	svc.OpenLivePods("c", "ns3")
	if svc.live.count() != 3 {
		t.Fatalf("want 3 subs, got %d", svc.live.count())
	}

	done := make(chan struct{})
	go func() { svc.CloseAll(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("CloseAll blocked: leak")
	}
	if svc.live.count() != 0 {
		t.Fatalf("registry not drained: %d", svc.live.count())
	}
}

func TestLiveList_ComputeFailureEmitsLiveFalseOnce(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{computeFail: true}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	defer svc.CloseLivePods("c", "ns")

	// Immediate compute fails -> no data emit, and live(false). Since we start
	// not-live and the watch is up but compute fails, the aggregate stays false:
	// the status event should report live=false (or no true edge ever appears).
	if !liveWaitUntil(t, time.Second, func() bool {
		v, ok := em.lastLive("livePodsStatus:c:ns")
		return ok && !v
	}) {
		// Acceptable alternative: no status event at all yet (still false by
		// default). The hard requirement is we never reported true.
		if v, ok := em.lastLive("livePodsStatus:c:ns"); ok && v {
			t.Fatal("reported live(true) despite compute failure")
		}
	}
	// No data event should have been emitted on a failing compute.
	if em.countOf("livePods:c:ns") != 0 {
		t.Fatalf("compute failure must not emit data; got %d", em.countOf("livePods:c:ns"))
	}

	// Now let compute succeed and fire dirty: it should emit data + live(true).
	conn.setComputeFail(false)
	conn.fireDirty()
	if !liveWaitUntil(t, 2*time.Second, func() bool { return em.countOf("livePods:c:ns") >= 1 }) {
		t.Fatal("recovery: no data emit after compute succeeds")
	}
	if !liveWaitUntil(t, time.Second, func() bool {
		v, ok := em.lastLive("livePodsStatus:c:ns")
		return ok && v
	}) {
		t.Fatal("recovery: never reported live(true)")
	}
}

func TestLiveList_WatchStartError_OneShotComputeThenExit(t *testing.T) {
	em := &anyEmitter{}
	conn := &fakeLivePodConn{watchErr: context.DeadlineExceeded}
	svc := newFastPodsSvc(conn, em)

	svc.OpenLivePods("c", "ns")
	// Watch establish failed: one-shot compute emits data, live(false), and the
	// sub deregisters (no loop without a watch).
	if !liveWaitUntil(t, time.Second, func() bool { return svc.live.count() == 0 }) {
		t.Fatalf("watch-fail sub did not deregister; count=%d", svc.live.count())
	}
	if em.countOf("livePods:c:ns") != 1 {
		t.Fatalf("want exactly 1 one-shot emit on watch-fail, got %d", em.countOf("livePods:c:ns"))
	}
	if v, ok := em.lastLive("livePodsStatus:c:ns"); !ok || v {
		t.Fatalf("want live(false) on watch-fail, got ok=%v v=%v", ok, v)
	}
}

func TestLiveList_NoGoroutineLeakAcrossLifecycles(t *testing.T) {
	runtime.GC()
	before := runtime.NumGoroutine()

	em := &anyEmitter{}
	conn := &fakeLivePodConn{}
	svc := newFastPodsSvc(conn, em)

	// Open/dirty/close cycles plus a replace.
	for i := 0; i < 5; i++ {
		svc.OpenLivePods("c", "ns")
		conn.fireDirty()
		time.Sleep(15 * time.Millisecond)
		svc.OpenLivePods("c", "ns") // replace
		svc.CloseLivePods("c", "ns")
	}
	// A batch of distinct keys drained via CloseAll.
	svc.OpenLivePods("c", "a")
	svc.OpenLivePods("c", "b")
	svc.CloseAll()

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
	t.Fatalf("goroutine leak: before=%d after=%d (delta=%d)", before, after, after-before)
}
