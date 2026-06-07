package metrics

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

// fakeFactory records which transport was built and returns a marker Querier.
type fakeFactory struct{ built string }

type markerQ struct{ tag string }

// satisfies Querier; Resolve only constructs the transport, never calls it.
func (markerQ) InstantQuery(context.Context, string) (int, []byte, error) { return 200, nil, nil }

func (f *fakeFactory) Direct(base, _ string, _ bool) Querier {
	f.built = "direct:" + base
	return markerQ{f.built}
}
func (f *fakeFactory) Proxy(c ServiceCandidate) Querier {
	f.built = "proxy:" + c.Namespace + "/" + c.Name + ":" + c.Port
	return markerQ{f.built}
}

func TestResolve(t *testing.T) {
	t.Run("endpoint wins, trims trailing slash, warns on serviceRef", func(t *testing.T) {
		f := &fakeFactory{}
		r := Resolve(config.MetricsConfig{
			Endpoint:   "https://host/prom/",
			ServiceRef: &config.MetricsServiceRef{Namespace: "m", Name: "p", Port: "9090"},
		}, DiscoveryResult{}, f)
		if r.Mode != ModeExplicitEndpoint || r.Source != "https://host/prom" {
			t.Fatalf("got mode=%s source=%s", r.Mode, r.Source)
		}
		if r.Warning == "" {
			t.Fatal("want serviceRef-ignored warning")
		}
	})
	t.Run("serviceRef proxy", func(t *testing.T) {
		f := &fakeFactory{}
		r := Resolve(config.MetricsConfig{ServiceRef: &config.MetricsServiceRef{Namespace: "m", Name: "p", Port: "9090"}}, DiscoveryResult{}, f)
		if r.Mode != ModeExplicitService || r.Source != "m/p:9090" {
			t.Fatalf("got mode=%s source=%s", r.Mode, r.Source)
		}
		if f.built != "proxy:m/p:9090" {
			t.Fatalf("factory not called as expected: %s", f.built)
		}
	})
	t.Run("discovered", func(t *testing.T) {
		f := &fakeFactory{}
		r := Resolve(config.MetricsConfig{}, DiscoveryResult{Chosen: &ServiceCandidate{Namespace: "monitoring", Name: "prometheus-operated", Port: "9090", Scheme: "http"}}, f)
		if r.Mode != ModeDiscovered || r.Source != "monitoring/prometheus-operated:9090" {
			t.Fatalf("got mode=%s source=%s", r.Mode, r.Source)
		}
		if f.built != "proxy:monitoring/prometheus-operated:9090" {
			t.Fatalf("factory not called as expected: %s", f.built)
		}
	})
	t.Run("multi-match unavailable", func(t *testing.T) {
		r := Resolve(config.MetricsConfig{}, DiscoveryResult{MultiMatch: true}, &fakeFactory{})
		if r.Mode != ModeUnavailable || r.Reason == "" || r.Transport != nil {
			t.Fatalf("got %+v", r)
		}
	})
	t.Run("none unavailable", func(t *testing.T) {
		r := Resolve(config.MetricsConfig{}, DiscoveryResult{}, &fakeFactory{})
		if r.Mode != ModeUnavailable || r.Transport != nil {
			t.Fatalf("got %+v", r)
		}
	})
}
