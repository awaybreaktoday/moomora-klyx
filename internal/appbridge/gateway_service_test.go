package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/gwapi"
)

type fakeGatewayConn struct {
	refs   []gwapi.GatewayRef
	served bool
	topo   gwapi.Topology
	err    error
}

func (f *fakeGatewayConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	return f.refs, f.served, nil
}
func (f *fakeGatewayConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	return f.topo, f.err
}

func TestListGatewaysDTO(t *testing.T) {
	conn := &fakeGatewayConn{served: true, refs: []gwapi.GatewayRef{{Namespace: "infra", Name: "eg", ClassName: "envoy-gateway", Accepted: true, Programmed: true}}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	out := svc.ListGateways("x")
	if !out.GatewayAPIServed || len(out.Gateways) != 1 || out.Gateways[0].Name != "eg" {
		t.Fatalf("list: %+v", out)
	}
}

func TestGetGatewayTopologyDTO(t *testing.T) {
	conn := &fakeGatewayConn{topo: gwapi.Topology{
		Gateway:  gwapi.GatewayNode{Namespace: "infra", Name: "eg", ClassName: "envoy-gateway", Programmed: true, Listeners: []gwapi.Listener{{Name: "http", Protocol: "HTTP", Port: 80}}},
		Routes:   []gwapi.RouteNode{{Namespace: "apps", Name: "share", Accepted: true, Matches: []gwapi.Match{{PathType: "PathPrefix", PathValue: "/x"}}, Services: []gwapi.ServiceNode{{Name: "share-api", Resolved: true, Type: "ClusterIP", Port: 80}}, Pods: gwapi.PodCount{Ready: 2, Total: 2}}},
		Warnings: []string{"heads up"},
	}}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")
	if d.Gateway.Name != "eg" || !d.Gateway.Programmed || len(d.Routes) != 1 {
		t.Fatalf("topology: %+v", d)
	}
	if d.Routes[0].Services[0].Name != "share-api" || d.Routes[0].Pods.Ready != 2 {
		t.Fatalf("route: %+v", d.Routes[0])
	}
	if len(d.Warnings) != 1 || d.Error != "" {
		t.Fatalf("warnings/error: %+v", d)
	}
}

func TestGetGatewayTopologyErrorSurfaced(t *testing.T) {
	conn := &fakeGatewayConn{err: context.DeadlineExceeded}
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
	d := svc.GetGatewayTopology("x", "infra", "eg")
	if d.Error == "" {
		t.Fatalf("a core error must surface in Error, got %+v", d)
	}
}

func TestGatewayUnknownClusterEmpty(t *testing.T) {
	svc := NewGatewayService(func(string) (GatewayConn, bool) { return nil, false })
	if out := svc.ListGateways("ghost"); out.GatewayAPIServed || len(out.Gateways) != 0 {
		t.Fatalf("want empty, got %+v", out)
	}
}
