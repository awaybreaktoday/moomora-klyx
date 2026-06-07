package routemetrics

import (
	"context"
	"fmt"

	"github.com/moomora/klyx/internal/metrics"
)

// Envoy metric and label names. SINGLE source of truth — native verification
// confirms/adjusts these before merge (see the spec's hard gate). Do not
// inline these strings elsewhere.
const (
	mRqTotal     = "envoy_cluster_upstream_rq_total"
	mRqTime      = "envoy_cluster_upstream_rq_time_bucket"
	mRqXX        = "envoy_cluster_upstream_rq_xx"
	lClusterName = "envoy_cluster_name"
	lRespClass   = "envoy_response_code_class"
	rateWindow   = "5m"
)

// EnvoyClusterSource builds Envoy-cluster PromQL and reduces the result into
// per-route metrics. Pure of clocks; the fleet layer stamps Status.UpdatedAt.
type EnvoyClusterSource struct{ client *metrics.Client }

func NewEnvoyClusterSource(c *metrics.Client) *EnvoyClusterSource {
	return &EnvoyClusterSource{client: c}
}

func (s *EnvoyClusterSource) QueryRouteMetrics(ctx context.Context, routeKeys []string) (map[string]RouteMetrics, Status, error) {
	if len(routeKeys) == 0 {
		return map[string]RouteMetrics{}, Status{Available: true}, nil
	}
	sel := buildSelector(routeKeys)

	rps, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s}[%s]))", lClusterName, mRqTotal, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	p50, err := s.client.InstantVector(ctx, fmt.Sprintf("histogram_quantile(0.50, sum by (%s, le)(rate(%s{%s}[%s])))", lClusterName, mRqTime, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	p99, err := s.client.InstantVector(ctx, fmt.Sprintf("histogram_quantile(0.99, sum by (%s, le)(rate(%s{%s}[%s])))", lClusterName, mRqTime, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	rq5xx, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s,%s=\"5\"}[%s]))", lClusterName, mRqXX, sel, lRespClass, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}
	rqall, err := s.client.InstantVector(ctx, fmt.Sprintf("sum by (%s)(rate(%s{%s}[%s]))", lClusterName, mRqXX, sel, rateWindow))
	if err != nil {
		return nil, Status{}, err
	}

	out := reduce(rps, p50, p99, rq5xx, rqall)
	if len(out) > 0 {
		return out, Status{Available: true}, nil
	}

	// No matched series: distinguish "Envoy not scraped at all" from "these
	// routes are just idle / mislabeled". Reuse the verified rq-total constant.
	// Existence probe is intentionally UNSCOPED (counts all Envoy rq_total
	// series, not just httproute). Per the spec it answers "is Envoy scraped at
	// all"; the exact wording vs scoping is a native-verification decision.
	exist, err := s.client.InstantScalar(ctx, fmt.Sprintf("count(%s)", mRqTotal))
	if err != nil {
		return nil, Status{}, err
	}
	// Real Prometheus count() over no series returns an empty vector (-> Absent);
	// the ==0 check is defensive against a malformed response.
	if exist.Absent || exist.Value == 0 {
		return out, Status{Available: false, Message: "no envoy_cluster_* series found"}, nil
	}
	return out, Status{Available: true, Message: "no route series matched this topology"}, nil
}

type acc struct {
	rps     float64
	rpsHas  bool
	p50     float64
	p50Has  bool
	p99     float64
	p99Has  bool
	f5xx    float64
	fall    float64
	fallHas bool
}

// reduce maps per-rule vector elements to per-route metrics: rps summed across
// rules; p50/p99 max across rules (worst-rule tail); err = sum(5xx)/sum(all)
// divided ONCE per route (never averaging per-rule fractions). A route is
// "measured" iff it has an rps element (the counter exists even at 0 traffic).
func reduce(rps, p50, p99, rq5xx, rqall []metrics.LabeledSample) map[string]RouteMetrics {
	accs := map[string]*acc{}
	get := func(k string) *acc {
		a := accs[k]
		if a == nil {
			a = &acc{}
			accs[k] = a
		}
		return a
	}
	for _, s := range rps {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			a.rps += s.Value
			a.rpsHas = true
		}
	}
	// p50/p99 are max across a route's rules (worst-rule tail). NOTE: because
	// the two quantiles are reduced independently, a multi-rule route can report
	// p50 > p99 when the high-p50 rule differs from the high-p99 rule. Single-rule
	// routes (the common case) can never invert. A bucket-level re-aggregation
	// (route-level histogram_quantile) would fix it but needs a query redesign.
	for _, s := range p50 {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			if !a.p50Has || s.Value > a.p50 {
				a.p50 = s.Value
				a.p50Has = true
			}
		}
	}
	for _, s := range p99 {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			if !a.p99Has || s.Value > a.p99 {
				a.p99 = s.Value
				a.p99Has = true
			}
		}
	}
	for _, s := range rq5xx {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			get(k).f5xx += s.Value
		}
	}
	for _, s := range rqall {
		if k, ok := parseClusterName(s.Labels[lClusterName]); ok {
			a := get(k)
			a.fall += s.Value
			a.fallHas = true
		}
	}

	out := make(map[string]RouteMetrics, len(accs))
	for k, a := range accs {
		if !a.rpsHas {
			continue // not measured without an rps series
		}
		rm := RouteMetrics{}
		v := a.rps
		rm.RPS = &v
		if a.p50Has {
			p := a.p50
			rm.P50 = &p
		}
		if a.p99Has {
			p := a.p99
			rm.P99 = &p
		}
		if a.fallHas && a.fall > 0 {
			e := a.f5xx / a.fall
			if e > 1 { // 5xx rate can momentarily exceed total under scrape skew / counter resets
				e = 1
			}
			rm.ErrRate = &e
		}
		out[k] = rm
	}
	return out
}
