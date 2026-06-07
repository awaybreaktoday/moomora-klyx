package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/metrics"
)

type fakeMetricsConn struct {
	cm  metrics.ClusterMetrics
	cap metrics.MetricsCapability
}

func (f fakeMetricsConn) ClusterMetrics(context.Context, bool) (metrics.ClusterMetrics, metrics.MetricsCapability) {
	return f.cm, f.cap
}

func TestGetClusterMetrics(t *testing.T) {
	t.Run("cluster miss → unavailable", func(t *testing.T) {
		s := NewMetricsService(func(string) (MetricsConn, bool) { return nil, false })
		dto := s.GetClusterMetrics("nope", false)
		if dto.Available || dto.Mode != string(metrics.ModeUnavailable) {
			t.Fatalf("got %+v", dto)
		}
	})
	t.Run("available with fractions", func(t *testing.T) {
		cpu, mem := 0.38, 0.61
		conn := fakeMetricsConn{
			cm:  metrics.ClusterMetrics{CPUFraction: &cpu, MemFraction: &mem},
			cap: metrics.MetricsCapability{Available: true, Mode: metrics.ModeDiscovered, Source: "monitoring/prometheus-operated:9090"},
		}
		s := NewMetricsService(func(string) (MetricsConn, bool) { return conn, true })
		dto := s.GetClusterMetrics("c", false)
		if !dto.Available || dto.CPUFraction == nil || *dto.CPUFraction != 0.38 || dto.Source == "" {
			t.Fatalf("got %+v", dto)
		}
	})
	t.Run("available but nil fractions stay nil", func(t *testing.T) {
		conn := fakeMetricsConn{cap: metrics.MetricsCapability{Available: true, Mode: metrics.ModeExplicitEndpoint}}
		s := NewMetricsService(func(string) (MetricsConn, bool) { return conn, true })
		dto := s.GetClusterMetrics("c", false)
		if dto.CPUFraction != nil || dto.MemFraction != nil {
			t.Fatal("nil fractions must round-trip as nil")
		}
	})
}
