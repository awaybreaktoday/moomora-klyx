package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/metrics"
)

const metricsTimeout = 30 * time.Second

// MetricsConn is the per-cluster read surface MetricsService needs (lookup-seam
// pattern; cf. CRDService/GatewayService). fleet.ClusterConn satisfies it.
type MetricsConn interface {
	ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability)
}

// MetricsService is bound to JS. On-demand only; no push loop.
type MetricsService struct {
	lookup func(string) (MetricsConn, bool)
}

func NewMetricsService(lookup func(string) (MetricsConn, bool)) *MetricsService {
	return &MetricsService{lookup: lookup}
}

// GetClusterMetrics returns the cluster's metrics + connection status.
// forceReprobe re-resolves and re-probes (the manual-refresh escape hatch).
func (s *MetricsService) GetClusterMetrics(cluster string, forceReprobe bool) MetricsDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return MetricsDTO{Mode: string(metrics.ModeUnavailable), Reason: "cluster not connected"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), metricsTimeout)
	defer cancel()
	cm, cap := conn.ClusterMetrics(ctx, forceReprobe)
	return MetricsDTO{
		Available:   cap.Available,
		Mode:        string(cap.Mode),
		Source:      cap.Source,
		Warning:     cap.Warning,
		Reason:      cap.Reason,
		CPUFraction: cm.CPUFraction,
		MemFraction: cm.MemFraction,
	}
}
