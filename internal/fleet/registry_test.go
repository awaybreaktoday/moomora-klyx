package fleet

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/gitops/flux"
)

type fakeConn struct {
	name  string
	snap  Snapshot
	start func()
}

func (f *fakeConn) Name() string { return f.name }
func (f *fakeConn) Start(ctx context.Context) {
	if f.start != nil {
		f.start()
	}
}
func (f *fakeConn) Snapshot() Snapshot                  { return f.snap }
func (f *fakeConn) OpenGitOps()                         {}
func (f *fakeConn) CloseGitOps()                        {}
func (f *fakeConn) GitOpsResources() []flux.Resource    { return nil }
func (f *fakeConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	return nil, false
}

func TestRegistryStartsAllConnsAndIsolatesFailure(t *testing.T) {
	cfg := &config.Config{Clusters: []config.ClusterConfig{
		{Name: "good-1"}, {Name: "bad"}, {Name: "good-2"},
	}}

	factory := func(cc config.ClusterConfig) (Conn, error) {
		switch cc.Name {
		case "bad":
			// Simulate a conn that fails to construct (e.g. bad kubeconfig).
			return nil, context.DeadlineExceeded
		case "good-1":
			return &fakeConn{name: "good-1", snap: Snapshot{Name: "good-1", State: Synced}}, nil
		default:
			return &fakeConn{name: "good-2", snap: Snapshot{Name: "good-2", State: Synced}}, nil
		}
	}

	reg := NewRegistry(cfg, factory)
	reg.Start(context.Background())

	snaps := reg.Snapshots()
	if len(snaps) != 3 {
		t.Fatalf("want 3 snapshots, got %d", len(snaps))
	}
	byName := map[string]Snapshot{}
	for _, s := range snaps {
		byName[s.Name] = s
	}
	if byName["good-1"].State != Synced || byName["good-2"].State != Synced {
		t.Fatalf("good conns should be Synced: %+v", byName)
	}
	if byName["bad"].State != Failed {
		t.Fatalf("bad conn should be Failed, got %v", byName["bad"].State)
	}
	if byName["bad"].Reason == "" {
		t.Fatal("failed conn must carry a reason")
	}
}

func TestRegistryStartIsIdempotent(t *testing.T) {
	cfg := &config.Config{Clusters: []config.ClusterConfig{{Name: "a"}, {Name: "b"}}}
	factory := func(cc config.ClusterConfig) (Conn, error) {
		return &fakeConn{name: cc.Name, snap: Snapshot{Name: cc.Name, State: Synced}}, nil
	}
	reg := NewRegistry(cfg, factory)
	reg.Start(context.Background())
	reg.Start(context.Background()) // second call must be a no-op
	if got := len(reg.Snapshots()); got != 2 {
		t.Fatalf("want 2 snapshots after double Start, got %d", got)
	}
}
