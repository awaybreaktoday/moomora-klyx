package metrics

import "context"

// Probe resolves a candidate then liveness-checks it. Available is true only
// after a passing vector(1). A resolved-but-unreachable backend reports
// unavailable with the real error.
func Probe(ctx context.Context, res Resolution) MetricsCapability {
	out := MetricsCapability{Mode: res.Mode, Source: res.Source, Warning: res.Warning, Reason: res.Reason}
	if res.Transport == nil {
		return out // Available stays false; Reason already set for unavailable
	}
	if err := NewClient(res.Transport).Liveness(ctx); err != nil {
		out.Reason = err.Error()
		return out
	}
	out.Available = true
	return out
}
