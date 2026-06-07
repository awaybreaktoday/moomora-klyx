package fleet

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"k8s.io/client-go/kubernetes/fake"
)

// fleetVecQ answers the liveness probe AND the route queries.
type fleetVecQ struct{}

func (fleetVecQ) InstantQuery(_ context.Context, promql string) (int, []byte, error) {
	switch {
	case strings.Contains(promql, "vector(1)"):
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[{"value":[1,"1"]}]}}`), nil
	case strings.Contains(promql, "upstream_rq_total"):
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"envoy_cluster_name":"httproute/default/web/rule/0"},"value":[1,"3.5"]}]}}`), nil
	default:
		return 200, []byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`), nil
	}
}

func TestRouteMetricsEmptyKeys(t *testing.T) {
	c := &ClusterConn{typed: fake.NewSimpleClientset(), clk: clock.NewFake(time.Unix(0, 0))}
	m, st := c.RouteMetrics(context.Background(), nil)
	if !st.Available || len(m) != 0 {
		t.Fatalf("empty keys: want available empty, got %+v %+v", m, st)
	}
}

func TestRouteMetricsGateEnvoyAbsent(t *testing.T) {
	c := &ClusterConn{typed: fake.NewSimpleClientset(), clk: clock.NewFake(time.Unix(0, 0))}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: false}}
	_, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if st.Available || st.Message != "Envoy Gateway not detected" {
		t.Fatalf("want envoy-not-detected, got %+v", st)
	}
}

func TestRouteMetricsGateMetricsUnavailable(t *testing.T) {
	c := &ClusterConn{
		typed:      fake.NewSimpleClientset(),
		clk:        clock.NewFake(time.Unix(0, 0)),
		metricsCfg: config.MetricsConfig{},
	}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: true}}
	_, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if st.Available || st.Message == "" {
		t.Fatalf("want metrics-unavailable reason, got %+v", st)
	}
}

func TestRouteMetricsHappy(t *testing.T) {
	clk := clock.NewFake(time.Unix(100, 0))
	c := &ClusterConn{
		typed:      fake.NewSimpleClientset(),
		clk:        clk,
		metricsCfg: config.MetricsConfig{Endpoint: "http://prom"},
		metricsTF:  fakeTF{q: fleetVecQ{}},
	}
	c.caps = capability.Set{Network: capability.NetworkCapability{HasEnvoyProxy: true}}
	m, st := c.RouteMetrics(context.Background(), []string{"default/web"})
	if !st.Available {
		t.Fatalf("want available, got %+v", st)
	}
	if !st.UpdatedAt.Equal(clk.Now()) {
		t.Fatalf("UpdatedAt should be stamped to now, got %v", st.UpdatedAt)
	}
	if rm, ok := m["default/web"]; !ok || rm.RPS == nil {
		t.Fatalf("want web rps, got %+v", m)
	}
}
