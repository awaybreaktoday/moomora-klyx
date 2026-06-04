package appbridge

import (
	"sync"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

type fakeGitOpsConn struct {
	mu     sync.Mutex
	opened int
	closed int
	res    []flux.Resource
}

func (f *fakeGitOpsConn) OpenGitOps()  { f.mu.Lock(); f.opened++; f.mu.Unlock() }
func (f *fakeGitOpsConn) CloseGitOps() { f.mu.Lock(); f.closed++; f.mu.Unlock() }
func (f *fakeGitOpsConn) GitOpsResources() []flux.Resource {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.res
}

func TestGitOpsServiceOpenEmitsAndCloseStops(t *testing.T) {
	conn := &fakeGitOpsConn{res: []flux.Resource{
		{Kind: flux.KustomizationKind, Name: "flux-system", Ready: flux.Ready},
	}}
	lookup := func(name string) (GitOpsConn, bool) {
		if name == "x" {
			return conn, true
		}
		return nil, false
	}
	em := &fakeEmitter{}
	svc := NewGitOpsService(lookup, em, func() time.Time { return time.Now() }, 10*time.Millisecond)

	svc.Open("x")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		em.mu.Lock()
		n := em.events
		em.mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	em.mu.Lock()
	got := em.events
	em.mu.Unlock()
	if got < 1 {
		t.Fatal("expected at least one gitops:updated emit")
	}

	svc.Close("x")
	conn.mu.Lock()
	opened, closed := conn.opened, conn.closed
	conn.mu.Unlock()
	if opened != 1 || closed != 1 {
		t.Fatalf("want opened=1 closed=1, got %d/%d", opened, closed)
	}
}

func TestGitOpsServiceOpenUnknownClusterNoop(t *testing.T) {
	lookup := func(string) (GitOpsConn, bool) { return nil, false }
	svc := NewGitOpsService(lookup, &fakeEmitter{}, time.Now, time.Second)
	svc.Open("ghost") // must not panic
	svc.Close("ghost")
}
