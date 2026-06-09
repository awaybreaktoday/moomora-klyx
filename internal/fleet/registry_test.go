package fleet

import (
	"context"
	"io"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/clustermesh"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/crd"
	"github.com/moomora/klyx/internal/gitops/flux"
	"github.com/moomora/klyx/internal/gwapi"
	"github.com/moomora/klyx/internal/metrics"
	"github.com/moomora/klyx/internal/routemetrics"
	"github.com/moomora/klyx/internal/workloads"
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
func (f *fakeConn) Snapshot() Snapshot               { return f.snap }
func (f *fakeConn) OpenGitOps()                      {}
func (f *fakeConn) CloseGitOps()                     {}
func (f *fakeConn) GitOpsResources() []flux.Resource { return nil }
func (f *fakeConn) GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool) {
	return nil, false
}
func (f *fakeConn) Reconcile(ctx context.Context, kind, ns, name string) error { return nil }
func (f *fakeConn) SetSuspend(ctx context.Context, kind, ns, name string, suspend bool) error {
	return nil
}
func (f *fakeConn) SourceURL(ctx context.Context, kind, ns, name string) (string, bool) {
	return "", false
}
func (f *fakeConn) ListCRDs(ctx context.Context) ([]crd.Info, error) { return nil, nil }
func (f *fakeConn) ListWorkloads(context.Context, string) ([]workloads.Workload, bool, error) {
	return nil, false, nil
}
func (f *fakeConn) ListPods(context.Context, string) ([]workloads.PodSummary, error) {
	return nil, nil
}
func (f *fakeConn) DeletePod(context.Context, string, string) error { return nil }
func (f *fakeConn) ListEvents(context.Context, string) ([]workloads.EventSummary, error) {
	return nil, nil
}
func (f *fakeConn) PodDetail(context.Context, string, string) (PodDetail, error) {
	return PodDetail{}, nil
}
func (f *fakeConn) PodLogStream(context.Context, string, string, string, bool, int64) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (f *fakeConn) WorkloadMetrics(context.Context, string) (map[string]workloads.Usage, workloads.UsageStatus) {
	return nil, workloads.UsageStatus{}
}
func (f *fakeConn) RolloutRestart(context.Context, string, string, string) error { return nil }
func (f *fakeConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	return 0, false, nil
}
func (f *fakeConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	return nil, "", nil
}
func (f *fakeConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	return crd.InstanceDetail{}, nil
}
func (f *fakeConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	return nil, false, nil
}
func (f *fakeConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	return gwapi.Topology{}, nil
}
func (f *fakeConn) MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus) {
	return clustermesh.Member{Cluster: f.name, Present: true}, MeshReadStatus{}
}
func (f *fakeConn) HasGlobalService(ctx context.Context, ns, name string) bool { return false }
func (f *fakeConn) ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability) {
	return metrics.ClusterMetrics{}, metrics.MetricsCapability{}
}
func (f *fakeConn) RouteMetrics(context.Context, []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	return nil, routemetrics.Status{}
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
