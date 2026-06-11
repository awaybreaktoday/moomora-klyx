package appbridge

import (
	"context"
	"errors"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/gitops/argo"
)

type fakeArgoConn struct {
	apps    []argo.App
	listErr error
	calls   []string
}

func (f *fakeArgoConn) ListArgoApps(context.Context) ([]argo.App, error) {
	return f.apps, f.listErr
}
func (f *fakeArgoConn) RefreshArgoApp(_ context.Context, ns, name string) error {
	f.calls = append(f.calls, "refresh:"+ns+"/"+name)
	return nil
}
func (f *fakeArgoConn) SyncArgoApp(_ context.Context, ns, name, rev string) error {
	f.calls = append(f.calls, "sync:"+ns+"/"+name+"@"+rev)
	return nil
}

func TestListApplications(t *testing.T) {
	conn := &fakeArgoConn{apps: []argo.App{
		{Namespace: "argocd", Name: "broken-app", SyncStatus: "OutOfSync", HealthStatus: "Degraded", ReconciledAt: time.Unix(1000, 0)},
		{Namespace: "argocd", Name: "ok-app", SyncStatus: "Synced", HealthStatus: "Healthy", AutoSync: true},
	}}
	s := NewArgoService(func(string) (ArgoConn, bool) { return conn, true })
	r := s.ListApplications("c")
	if !r.Available || len(r.Apps) != 2 {
		t.Fatalf("got %+v", r)
	}
	if !r.Apps[0].Broken || r.Apps[0].ReconciledUnix != 1000 {
		t.Fatalf("broken/reconciled mapping wrong: %+v", r.Apps[0])
	}
	if r.Apps[1].Broken || !r.Apps[1].AutoSync {
		t.Fatalf("healthy mapping wrong: %+v", r.Apps[1])
	}
}

func TestListApplicationsNotInstalled(t *testing.T) {
	gr := schema.GroupResource{Group: "argoproj.io", Resource: "applications"}
	conn := &fakeArgoConn{listErr: apierrors.NewNotFound(gr, "")}
	s := NewArgoService(func(string) (ArgoConn, bool) { return conn, true })
	r := s.ListApplications("c")
	if r.Available || r.Message == "" {
		t.Fatalf("missing CRD must read unavailable with message: %+v", r)
	}
}

func TestListApplicationsError(t *testing.T) {
	conn := &fakeArgoConn{listErr: errors.New("boom")}
	s := NewArgoService(func(string) (ArgoConn, bool) { return conn, true })
	if r := s.ListApplications("c"); r.Available || r.Message != "boom" {
		t.Fatalf("list error must surface: %+v", r)
	}
}

func TestRefreshAndSync(t *testing.T) {
	conn := &fakeArgoConn{}
	s := NewArgoService(func(string) (ArgoConn, bool) { return conn, true })
	if r := s.RefreshApp("c", "argocd", "demo"); !r.OK {
		t.Fatalf("refresh: %+v", r)
	}
	if r := s.SyncApp("c", "argocd", "demo", "main"); !r.OK {
		t.Fatalf("sync: %+v", r)
	}
	if len(conn.calls) != 2 || conn.calls[0] != "refresh:argocd/demo" || conn.calls[1] != "sync:argocd/demo@main" {
		t.Fatalf("calls: %v", conn.calls)
	}
	miss := NewArgoService(func(string) (ArgoConn, bool) { return nil, false })
	if r := miss.RefreshApp("nope", "ns", "n"); r.OK {
		t.Fatal("cluster miss must fail")
	}
}
