package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/fleet"
	"github.com/moomora/klyx/internal/metrics"
)

const metricsTimeout = 30 * time.Second

// MetricsConn is the per-cluster read surface MetricsService needs (lookup-seam
// pattern; cf. CRDService/GatewayService). fleet.ClusterConn satisfies it.
type MetricsConn interface {
	ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability)
	WorkloadSparklines(ctx context.Context, kind, namespace, name string) (fleet.SparklineSet, error)
	ClusterSparklines(ctx context.Context) (fleet.SparklineSet, error)
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

// GetWorkloadSparklines returns 30m cpu/mem range series for one workload
// (summed over its current pods). Available=false carries the reason; the
// series are never fabricated.
func (s *MetricsService) GetWorkloadSparklines(cluster, namespace, kind, name string) SparklinesDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return SparklinesDTO{Message: "cluster not connected"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), metricsTimeout)
	defer cancel()
	set, err := conn.WorkloadSparklines(ctx, kind, namespace, name)
	if err != nil {
		return SparklinesDTO{Message: err.Error()}
	}
	return sparklinesDTO(set)
}

// GetClusterSparklines returns 30m cluster cpu/mem utilisation fractions —
// the range twins of GetClusterMetrics' instant readout.
func (s *MetricsService) GetClusterSparklines(cluster string) SparklinesDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return SparklinesDTO{Message: "cluster not connected"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), metricsTimeout)
	defer cancel()
	set, err := conn.ClusterSparklines(ctx)
	if err != nil {
		return SparklinesDTO{Message: err.Error()}
	}
	return sparklinesDTO(set)
}

func sparklinesDTO(set fleet.SparklineSet) SparklinesDTO {
	return SparklinesDTO{Available: true, CPU: pointsDTO(set.CPU), Mem: pointsDTO(set.Mem)}
}

func pointsDTO(ps []metrics.Point) []PointDTO {
	out := make([]PointDTO, len(ps))
	for i, p := range ps {
		out[i] = PointDTO{T: p.Unix, V: p.Value}
	}
	return out
}
