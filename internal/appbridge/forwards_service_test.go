package appbridge

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"
)

// fwEmitter records forwards:changed payloads under a mutex for race-free polling.
type fwEmitter struct {
	mu     sync.Mutex
	events [][]ForwardDTO
}

func (e *fwEmitter) Emit(name string, data any) {
	if name != ForwardsChangedEvent {
		return
	}
	list, _ := data.([]ForwardDTO)
	e.mu.Lock()
	defer e.mu.Unlock()
	cp := make([]ForwardDTO, len(list))
	copy(cp, list)
	e.events = append(e.events, cp)
}

func (e *fwEmitter) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.events)
}

// last returns the most recent emitted list, or nil if none.
func (e *fwEmitter) last() []ForwardDTO {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.events) == 0 {
		return nil
	}
	return e.events[len(e.events)-1]
}

// fakeForwardsConn is a controllable conn: each PortForward hands back a done
// channel the test drives to simulate the tunnel dying. stop() closes a local
// stopped flag and (optionally) the done channel to release the supervisor.
type fakeForwardsConn struct {
	mu          sync.Mutex
	resolveErr  error
	resolvePod  string
	resolvePort int
	pfErr       error

	dones   []chan error // one per started forward, for the test to drive
	stopped int
}

func (c *fakeForwardsConn) ResolveServicePod(_ context.Context, _, _ string, port int) (string, int, error) {
	if c.resolveErr != nil {
		return "", 0, c.resolveErr
	}
	pod := c.resolvePod
	if pod == "" {
		pod = "backing-pod"
	}
	tp := c.resolvePort
	if tp == 0 {
		tp = port
	}
	return pod, tp, nil
}

func (c *fakeForwardsConn) PortForward(_ context.Context, _, _ string, localPort, _ int) (func(), int, <-chan error, error) {
	if c.pfErr != nil {
		return nil, 0, nil, c.pfErr
	}
	done := make(chan error, 1)
	c.mu.Lock()
	c.dones = append(c.dones, done)
	c.mu.Unlock()

	var once sync.Once
	stop := func() {
		once.Do(func() {
			c.mu.Lock()
			c.stopped++
			c.mu.Unlock()
			// Real fleet contract: stop() tears down the tunnel but does NOT push to
			// done (done carries only a natural exit from ForwardPorts). The appbridge
			// supervisor exits via its supCtx cancellation on an explicit stop. We
			// deliberately do not close done here so a clean stop never looks like a
			// natural death (which would emit a spurious "broken").
		})
	}
	local := localPort
	if local == 0 {
		local = 34567 // simulate an ephemeral port
	}
	return stop, local, done, nil
}

// killForward drives the i-th started forward's done channel to simulate the
// tunnel dying on its own.
func (c *fakeForwardsConn) killForward(i int) {
	c.mu.Lock()
	done := c.dones[i]
	c.mu.Unlock()
	done <- context.DeadlineExceeded
}

func (c *fakeForwardsConn) stopCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stopped
}

func fwLookup(conn ForwardsConn) func(string) (ForwardsConn, bool) {
	return func(string) (ForwardsConn, bool) { return conn, true }
}

func fwWaitUntil(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

func (s *ForwardsService) forwardCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.forwards)
}

// --- tests ---

func TestStartForward_ClusterMiss(t *testing.T) {
	em := &fwEmitter{}
	svc := NewForwardsService(func(string) (ForwardsConn, bool) { return nil, false }, em)
	res := svc.StartForward("nope", "ns", "Pod", "p", 0, 8080)
	if res.Error == "" || res.Forward != nil {
		t.Fatalf("want cluster-miss error, got %+v", res)
	}
}

func TestStartForward_PodLifecycle(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)

	res := svc.StartForward("c", "team", "Pod", "api", 0, 8080)
	if res.Error != "" || res.Forward == nil {
		t.Fatalf("start failed: %+v", res)
	}
	if res.Forward.Status != "active" {
		t.Fatalf("status = %q, want active", res.Forward.Status)
	}
	if res.Forward.LocalPort == 0 {
		t.Fatal("ephemeral local port should be resolved (non-zero)")
	}
	if res.Forward.TargetKind != "Pod" || res.Forward.TargetName != "api" {
		t.Fatalf("target mismatch: %+v", res.Forward)
	}

	list := svc.ListForwards()
	if len(list) != 1 || list[0].ID != res.Forward.ID {
		t.Fatalf("list mismatch: %+v", list)
	}
	if em.count() == 0 {
		t.Fatal("start should have emitted forwards:changed")
	}

	// Stop it.
	stopRes := svc.StopForward(res.Forward.ID)
	if !stopRes.OK {
		t.Fatalf("stop not OK: %+v", stopRes)
	}
	if !fwWaitUntil(time.Second, func() bool { return svc.forwardCount() == 0 }) {
		t.Fatalf("registry not drained after stop: %d", svc.forwardCount())
	}
	if conn.stopCount() == 0 {
		t.Fatal("fleet stop() was never called")
	}
}

func TestStartForward_ServiceResolvesToPod(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{resolvePod: "svc-backing", resolvePort: 9090}
	svc := NewForwardsService(fwLookup(conn), em)

	res := svc.StartForward("c", "team", "Service", "api-svc", 0, 80)
	if res.Error != "" || res.Forward == nil {
		t.Fatalf("start failed: %+v", res)
	}
	// TargetKind stays Service for display; TargetPort is the resolved container port.
	if res.Forward.TargetKind != "Service" || res.Forward.TargetName != "api-svc" {
		t.Fatalf("service display lost: %+v", res.Forward)
	}
	if res.Forward.TargetPort != 9090 {
		t.Fatalf("resolved target port = %d, want 9090", res.Forward.TargetPort)
	}
}

func TestStartForward_ResolveErrorSurfaces(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{resolveErr: context.Canceled}
	svc := NewForwardsService(fwLookup(conn), em)
	res := svc.StartForward("c", "team", "Service", "api-svc", 0, 80)
	if res.Error == "" || res.Forward != nil {
		t.Fatalf("want resolve error, got %+v", res)
	}
	if svc.forwardCount() != 0 {
		t.Fatal("failed resolve must not register a forward")
	}
}

func TestForward_BrokenTransitionEmits(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)

	res := svc.StartForward("c", "team", "Pod", "api", 0, 8080)
	if res.Forward == nil {
		t.Fatalf("start failed: %+v", res)
	}
	before := em.count()

	// Tunnel dies on its own.
	conn.killForward(0)

	// Supervisor must flip to broken and emit.
	if !fwWaitUntil(time.Second, func() bool {
		l := em.last()
		return len(l) == 1 && l[0].Status == "broken"
	}) {
		t.Fatalf("never saw broken status emitted; last=%+v", em.last())
	}
	if em.count() <= before {
		t.Fatal("broken transition should have emitted a new event")
	}
	// The broken forward is retained so the user can see and dismiss it.
	if svc.forwardCount() != 1 {
		t.Fatalf("broken forward should remain registered, count=%d", svc.forwardCount())
	}

	// Stopping a broken forward removes it.
	svc.StopForward(res.Forward.ID)
	if !fwWaitUntil(time.Second, func() bool { return svc.forwardCount() == 0 }) {
		t.Fatal("broken forward not removed on stop")
	}
}

func TestStartForward_CapReturnsError(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)

	for i := 0; i < maxActiveForwards; i++ {
		res := svc.StartForward("c", "team", "Pod", "api", 0, 8080)
		if res.Forward == nil {
			t.Fatalf("start %d failed: %+v", i, res)
		}
	}
	// One past the cap must fail and start nothing.
	res := svc.StartForward("c", "team", "Pod", "api", 0, 8080)
	if res.Error == "" || res.Forward != nil {
		t.Fatalf("want at-cap error, got %+v", res)
	}
	if svc.forwardCount() != maxActiveForwards {
		t.Fatalf("count = %d, want cap %d (no eviction)", svc.forwardCount(), maxActiveForwards)
	}
	svc.StopAll()
}

func TestStopForward_Idempotent(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)
	res := svc.StartForward("c", "team", "Pod", "api", 0, 8080)

	svc.StopForward(res.Forward.ID)
	svc.StopForward(res.Forward.ID)   // second stop: no-op, must not panic
	svc.StopForward("does-not-exist") // unknown id: no-op
	if svc.forwardCount() != 0 {
		t.Fatalf("count = %d, want 0", svc.forwardCount())
	}
}

func TestStopAll_DrainsEveryForward(t *testing.T) {
	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)

	for i := 0; i < 5; i++ {
		svc.StartForward("c", "team", "Pod", "api", 0, 8080)
	}
	if svc.forwardCount() != 5 {
		t.Fatalf("want 5 forwards, got %d", svc.forwardCount())
	}

	done := make(chan struct{})
	go func() { svc.StopAll(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("StopAll blocked: leak")
	}
	if svc.forwardCount() != 0 {
		t.Fatalf("registry not drained after StopAll: %d", svc.forwardCount())
	}
}

// TestNoGoroutineLeakAcrossForwardLifecycles verifies every supervisor goroutine
// exits across {clean stop, natural death, StopAll}. After teardown the count
// must settle back to baseline.
func TestNoGoroutineLeakAcrossForwardLifecycles(t *testing.T) {
	runtime.GC()
	before := runtime.NumGoroutine()

	em := &fwEmitter{}
	conn := &fakeForwardsConn{}
	svc := NewForwardsService(fwLookup(conn), em)

	// Clean-stop path.
	r1 := svc.StartForward("c", "ns", "Pod", "a", 0, 80)
	svc.StopForward(r1.Forward.ID)

	// Natural-death path.
	r2 := svc.StartForward("c", "ns", "Pod", "b", 0, 80)
	_ = r2
	conn.killForward(1) // index 1: second started forward
	fwWaitUntil(time.Second, func() bool {
		l := em.last()
		return len(l) >= 1 && l[len(l)-1].Status == "broken"
	})
	svc.StopForward(r2.Forward.ID)

	// Bulk path.
	for i := 0; i < 4; i++ {
		svc.StartForward("c", "ns", "Pod", "c", 0, 80)
	}
	svc.StopAll()

	deadline := time.Now().Add(3 * time.Second)
	var after int
	for time.Now().Before(deadline) {
		runtime.GC()
		after = runtime.NumGoroutine()
		if after <= before+3 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("goroutine leak: before=%d after=%d (delta=%d)", before, after, after-before)
}
