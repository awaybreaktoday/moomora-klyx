package appbridge

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/gwapi"
	"github.com/moomora/klyx/internal/routemetrics"
)

type fakeRMConn struct {
	m  map[string]routemetrics.RouteMetrics
	st routemetrics.Status
}

func (f fakeRMConn) ListGateways(context.Context) ([]gwapi.GatewayRef, bool, error) { return nil, false, nil }
func (f fakeRMConn) GetGatewayTopology(context.Context, string, string) (gwapi.Topology, error) {
	return gwapi.Topology{}, nil
}
func (f fakeRMConn) RouteMetrics(context.Context, []string) (map[string]routemetrics.RouteMetrics, routemetrics.Status) {
	return f.m, f.st
}

func TestGetRouteMetrics(t *testing.T) {
	t.Run("cluster miss -> unavailable", func(t *testing.T) {
		s := NewGatewayService(func(string) (GatewayConn, bool) { return nil, false })
		dto := s.GetRouteMetrics("nope", []string{"default/web"})
		if dto.Status.Available {
			t.Fatalf("got %+v", dto)
		}
		if dto.Routes == nil {
			t.Fatal("Routes must be non-nil (JSON {})")
		}
	})
	t.Run("maps metrics + status + updatedAt", func(t *testing.T) {
		rps := 12.4
		conn := fakeRMConn{
			m:  map[string]routemetrics.RouteMetrics{"default/web": {RPS: &rps}},
			st: routemetrics.Status{Available: true, UpdatedAt: time.Unix(100, 0)},
		}
		s := NewGatewayService(func(string) (GatewayConn, bool) { return conn, true })
		dto := s.GetRouteMetrics("c", []string{"default/web"})
		if !dto.Status.Available || dto.Status.UpdatedAt == "" {
			t.Fatalf("status: %+v", dto.Status)
		}
		if dto.Routes["default/web"].RPS == nil || *dto.Routes["default/web"].RPS != 12.4 {
			t.Fatalf("routes: %+v", dto.Routes)
		}
	})
}
