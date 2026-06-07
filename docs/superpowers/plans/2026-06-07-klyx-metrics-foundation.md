# M7-a: Prometheus metrics foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Prometheus query data path end-to-end and prove it with on-demand cluster CPU/memory on the cluster Overview, honest about how it connected and honest when it can't.

**Architecture:** A new pure `internal/metrics` package owns PromQL querying (response parsing, two transports, 4-tier resolution, probe-confirmed capability). `internal/fleet` threads the per-cluster `MetricsConfig`, does live Service discovery, and exposes a lazy `ClusterMetrics` method with asymmetric capability caching. `internal/appbridge` exposes a `MetricsService` (lookup-seam pattern) to JS, which the cluster Overview calls on mount and on manual refresh.

**Tech Stack:** Go 1.26, client-go (typed client + REST service proxy), `net/http`/`httptest`, React 19 + TS + Zustand, Vitest 4, Wails v3.

**Spec:** `docs/superpowers/specs/2026-06-07-klyx-metrics-foundation-design.md`

---

## File structure

- `internal/metrics/model.go` — value types: `Sample`, `Querier`, `Mode`, `ServiceCandidate`, `DiscoveryResult`, `Resolution`, `MetricsCapability`, `ClusterMetrics`, `TransportFactory`.
- `internal/metrics/parse.go` — Prometheus envelope parsing, `Client.InstantScalar`, `Client.Liveness`.
- `internal/metrics/resolve.go` — `Resolve` (4-tier priority).
- `internal/metrics/transport.go` — `directTransport`, `proxyTransport`, exported constructors.
- `internal/metrics/capability.go` — `Probe`.
- `internal/config/config.go` — add `MetricsServiceRef`, validation.
- `internal/fleet/metrics.go` — discovery, transport factory, `ClusterMetrics` + caching, query consts.
- `internal/fleet/conn.go` — `Conn` interface + `ClusterConn` fields (metrics config, cache); `factory.go` threads `cc.Metrics`.
- `internal/appbridge/metrics_service.go` + `metrics_dto.go` — `MetricsConn`, `MetricsService`, `MetricsDTO`.
- `cmd/klyx/main.go` — register `MetricsService`.
- `cmd/klyx/frontend/src/store/fleet.ts` — `MetricsDTO`, `MetricsSlice`, setters.
- `cmd/klyx/frontend/src/bridge/metrics.ts` — `getClusterMetrics`.
- `cmd/klyx/frontend/src/cluster/Overview.tsx` — cpu/mem rows + monitoring line + refresh.

---

## Task 1: Config — MetricsServiceRef + validation

**Files:**
- Modify: `internal/config/config.go`
- Test: `internal/config/config_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/config/config_test.go`:

```go
func TestServiceRefValidation(t *testing.T) {
	cases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name:    "serviceRef missing port",
			yaml:    "clusters:\n  - name: a\n    metrics:\n      serviceRef:\n        namespace: monitoring\n        name: prometheus-operated\n",
			wantErr: "serviceRef",
		},
		{
			name:    "endpoint ending in /api/v1 rejected",
			yaml:    "clusters:\n  - name: a\n    metrics:\n      endpoint: https://host/prometheus/api/v1\n",
			wantErr: "/api/v1",
		},
		{
			name:    "bad scheme",
			yaml:    "clusters:\n  - name: a\n    metrics:\n      serviceRef:\n        namespace: monitoring\n        name: p\n        port: \"9090\"\n        scheme: ftp\n",
			wantErr: "scheme",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "f.yaml")
			if err := os.WriteFile(p, []byte(tc.yaml), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := Load(p)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestEndpointAndServiceRefWarning(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{{
		Name:    "a",
		Metrics: &MetricsConfig{Endpoint: "https://host", ServiceRef: &MetricsServiceRef{Namespace: "m", Name: "p", Port: "9090"}},
	}}}
	got := strings.Join(c.Warnings(), "|")
	if !strings.Contains(got, "serviceRef") || !strings.Contains(got, "endpoint") {
		t.Fatalf("want endpoint/serviceRef warning, got %q", got)
	}
}
```

Ensure the test file imports `path/filepath`, `os`, `strings` (some may already be present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/config/ -run 'ServiceRef|EndpointAndServiceRef' -v`
Expected: FAIL — `MetricsServiceRef` undefined / no validation.

- [ ] **Step 3: Implement**

In `internal/config/config.go`, extend `MetricsConfig` and add the ref type:

```go
type MetricsConfig struct {
	Endpoint      string             `yaml:"endpoint"`
	Token         string             `yaml:"token"`
	TLSSkipVerify bool               `yaml:"tlsSkipVerify"`
	ServiceRef    *MetricsServiceRef `yaml:"serviceRef"`
}

type MetricsServiceRef struct {
	Namespace string `yaml:"namespace"`
	Name      string `yaml:"name"`
	Port      string `yaml:"port"`
	Scheme    string `yaml:"scheme"` // http|https; default http
}
```

Add validation inside `validate()`'s per-cluster loop (after the duplicate-name check), then add the warning in `Warnings()`. Add `"strings"` is already imported.

In `validate()`:

```go
		if m := cl.Metrics; m != nil {
			if m.Endpoint != "" {
				endpoint := strings.TrimRight(m.Endpoint, "/")
				if strings.HasSuffix(endpoint, "/api/v1") {
					return fmt.Errorf("cluster %q: metrics.endpoint must be the Prometheus base URL without a trailing /api/v1", cl.Name)
				}
			}
			if sr := m.ServiceRef; sr != nil {
				if sr.Namespace == "" || sr.Name == "" || sr.Port == "" {
					return fmt.Errorf("cluster %q: metrics.serviceRef requires namespace, name, and port", cl.Name)
				}
				if sr.Scheme != "" && sr.Scheme != "http" && sr.Scheme != "https" {
					return fmt.Errorf("cluster %q: metrics.serviceRef.scheme must be http or https", cl.Name)
				}
			}
		}
```

In `Warnings()`, before `return w`:

```go
	for _, cl := range c.Clusters {
		if m := cl.Metrics; m != nil && m.Endpoint != "" && m.ServiceRef != nil {
			w = append(w, fmt.Sprintf("cluster %q: metrics.serviceRef is ignored because metrics.endpoint is set", cl.Name))
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go
git commit -m "feat(config): MetricsServiceRef + metrics endpoint/serviceRef validation"
```

---

## Task 2: metrics package — model + Prometheus response parsing

**Files:**
- Create: `internal/metrics/model.go`, `internal/metrics/parse.go`, `internal/metrics/parse_test.go`

- [ ] **Step 1: Write the failing test**

`internal/metrics/parse_test.go`:

```go
package metrics

import (
	"context"
	"testing"
)

// fakeQuerier returns canned status/body and records the last query.
type fakeQuerier struct {
	status   int
	body     string
	err      error
	lastQ    string
}

func (f *fakeQuerier) InstantQuery(_ context.Context, q string) (int, []byte, error) {
	f.lastQ = q
	return f.status, []byte(f.body), f.err
}

func TestInstantScalar(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantValue  float64
		wantAbsent bool
		wantErr    bool
	}{
		{name: "scalar", status: 200, body: `{"status":"success","data":{"resultType":"scalar","result":[1700000000,"0.42"]}}`, wantValue: 0.42},
		{name: "single vector", status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1700000000,"0.61"]}]}}`, wantValue: 0.61},
		{name: "empty vector is absent", status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[]}}`, wantAbsent: true},
		{name: "status error", status: 200, body: `{"status":"error","error":"bad query"}`, wantErr: true},
		{name: "non-prometheus body", status: 200, body: `<html>grafana</html>`, wantErr: true},
		{name: "multi-element vector", status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[{"value":[1,"1"]},{"value":[1,"2"]}]}}`, wantErr: true},
		{name: "http 503", status: 503, body: `service unavailable`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := NewClient(&fakeQuerier{status: tc.status, body: tc.body})
			s, err := c.InstantScalar(context.Background(), "q")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %+v", s)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if s.Absent != tc.wantAbsent {
				t.Fatalf("absent: want %v got %v", tc.wantAbsent, s.Absent)
			}
			if !tc.wantAbsent && s.Value != tc.wantValue {
				t.Fatalf("value: want %v got %v", tc.wantValue, s.Value)
			}
		})
	}
}

func TestLiveness(t *testing.T) {
	ok := NewClient(&fakeQuerier{status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[{"value":[1,"1"]}]}}`})
	if err := ok.Liveness(context.Background()); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	bad := NewClient(&fakeQuerier{status: 401, body: `unauthorized`})
	if err := bad.Liveness(context.Background()); err == nil {
		t.Fatal("want error on 401")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/metrics/ -run 'InstantScalar|Liveness' -v`
Expected: FAIL — package/types don't exist.

- [ ] **Step 3: Implement**

`internal/metrics/model.go`:

```go
// Package metrics owns the Prometheus query data path: PromQL instant queries,
// response parsing, transport selection, endpoint resolution, and
// probe-confirmed capability. Pure of client-go except the proxy transport.
package metrics

import "context"

// Sample is one scalar value from an instant query. Absent reports "no data".
type Sample struct {
	Value  float64
	Absent bool
}

// Querier executes a PromQL instant query and returns the HTTP status and body.
// Transports implement it; the Client parses.
type Querier interface {
	InstantQuery(ctx context.Context, promql string) (status int, body []byte, err error)
}

// Mode is how the connection was resolved.
type Mode string

const (
	ModeExplicitEndpoint Mode = "explicit-endpoint"
	ModeExplicitService  Mode = "explicit-service-ref"
	ModeDiscovered       Mode = "discovered-service"
	ModeUnavailable      Mode = "unavailable"
)

// ServiceCandidate is an in-cluster Prometheus Service to proxy to.
type ServiceCandidate struct {
	Namespace, Name, Port, Scheme string
}

// DiscoveryResult is the single reduced outcome of in-cluster discovery: at
// most one chosen candidate, or a multi-match signal (label fallback only).
type DiscoveryResult struct {
	Chosen     *ServiceCandidate
	MultiMatch bool
}

// Resolution is the resolved connection. Transport is nil when unavailable.
type Resolution struct {
	Mode      Mode
	Source    string // URL, or "ns/name:port" for service modes
	Transport Querier
	Warning   string // non-fatal context on a working connection
	Reason    string // why unavailable
}

// MetricsCapability is the probe-confirmed connection status handed to the UI.
type MetricsCapability struct {
	Available bool
	Mode      Mode
	Source    string
	Warning   string
	Reason    string
}

// ClusterMetrics is the proof-of-life readout. Nil pointers mean "no data",
// distinct from a real 0.
type ClusterMetrics struct {
	CPUFraction *float64
	MemFraction *float64
}

// TransportFactory builds transports. The fleet layer supplies the real one
// (it owns the cluster REST client); tests supply a fake.
type TransportFactory interface {
	Direct(base, token string, tlsSkipVerify bool) Querier
	Proxy(c ServiceCandidate) Querier
}
```

`internal/metrics/parse.go`:

```go
package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
)

// Client runs queries through a Querier and parses Prometheus responses.
type Client struct{ q Querier }

func NewClient(q Querier) *Client { return &Client{q: q} }

type promEnvelope struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	} `json:"data"`
	Error string `json:"error"`
}

type vectorSample struct {
	Value json.RawMessage `json:"value"` // [ts, "val"]
}

// parseValueTuple reads a Prometheus [ts, "val"] pair and returns the float.
// Values are JSON strings; we compare the PARSED float, never the raw string.
func parseValueTuple(raw json.RawMessage) (float64, error) {
	var pair [2]json.RawMessage
	if err := json.Unmarshal(raw, &pair); err != nil {
		return 0, err
	}
	var vs string
	if err := json.Unmarshal(pair[1], &vs); err != nil {
		return 0, err
	}
	return strconv.ParseFloat(vs, 64)
}

// InstantScalar runs an instant query expecting a scalar or single-element
// vector. Empty vector → Sample{Absent:true}. Multi-element → error.
func (c *Client) InstantScalar(ctx context.Context, promql string) (Sample, error) {
	status, body, err := c.q.InstantQuery(ctx, promql)
	if err != nil {
		return Sample{}, err
	}
	if status != 200 {
		return Sample{}, fmt.Errorf("prometheus returned HTTP %d", status)
	}
	var env promEnvelope
	if err := json.Unmarshal(body, &env); err != nil || env.Status == "" {
		return Sample{}, fmt.Errorf("not a Prometheus API response")
	}
	if env.Status != "success" {
		return Sample{}, fmt.Errorf("prometheus error: %s", env.Error)
	}
	switch env.Data.ResultType {
	case "scalar":
		v, err := parseValueTuple(env.Data.Result)
		if err != nil {
			return Sample{}, fmt.Errorf("parse scalar: %w", err)
		}
		return Sample{Value: v}, nil
	case "vector":
		var vec []vectorSample
		if err := json.Unmarshal(env.Data.Result, &vec); err != nil {
			return Sample{}, fmt.Errorf("parse vector: %w", err)
		}
		if len(vec) == 0 {
			return Sample{Absent: true}, nil
		}
		if len(vec) > 1 {
			return Sample{}, fmt.Errorf("expected single-element vector, got %d", len(vec))
		}
		v, err := parseValueTuple(vec[0].Value)
		if err != nil {
			return Sample{}, fmt.Errorf("parse vector value: %w", err)
		}
		return Sample{Value: v}, nil
	default:
		return Sample{}, fmt.Errorf("unexpected resultType %q", env.Data.ResultType)
	}
}

// Liveness runs vector(1) and returns nil only on a valid Prometheus 200 whose
// single value parses to 1.0.
func (c *Client) Liveness(ctx context.Context) error {
	s, err := c.InstantScalar(ctx, "vector(1)")
	if err != nil {
		return err
	}
	if s.Absent || s.Value != 1 {
		return fmt.Errorf("liveness query did not return 1")
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/metrics/ -run 'InstantScalar|Liveness' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/metrics/model.go internal/metrics/parse.go internal/metrics/parse_test.go
git commit -m "feat(metrics): model + Prometheus instant-query parsing + liveness"
```

---

## Task 3: metrics package — 4-tier Resolve

**Files:**
- Create: `internal/metrics/resolve.go`, `internal/metrics/resolve_test.go`

- [ ] **Step 1: Write the failing test**

`internal/metrics/resolve_test.go`:

```go
package metrics

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

// fakeFactory records which transport was built and returns a marker Querier.
type fakeFactory struct{ built string }

type markerQ struct{ tag string }

func (markerQ) InstantQuery(context.Context, string) (int, []byte, error) { return 200, nil, nil }

func (f *fakeFactory) Direct(base, _ string, _ bool) Querier { f.built = "direct:" + base; return markerQ{f.built} }
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
	})
	t.Run("discovered", func(t *testing.T) {
		f := &fakeFactory{}
		r := Resolve(config.MetricsConfig{}, DiscoveryResult{Chosen: &ServiceCandidate{Namespace: "monitoring", Name: "prometheus-operated", Port: "9090", Scheme: "http"}}, f)
		if r.Mode != ModeDiscovered || r.Source != "monitoring/prometheus-operated:9090" {
			t.Fatalf("got mode=%s source=%s", r.Mode, r.Source)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/metrics/ -run TestResolve -v`
Expected: FAIL — `Resolve` undefined.

- [ ] **Step 3: Implement**

`internal/metrics/resolve.go`:

```go
package metrics

import (
	"strings"

	"github.com/moomora/klyx/internal/config"
)

func schemeOr(s string) string {
	if s == "" {
		return "http"
	}
	return s
}

func sourceStr(c ServiceCandidate) string {
	return c.Namespace + "/" + c.Name + ":" + c.Port
}

// Resolve applies the 4-tier priority: endpoint → serviceRef → discovery →
// unavailable. `disco` is the single reduced discovery outcome.
func Resolve(cfg config.MetricsConfig, disco DiscoveryResult, tf TransportFactory) Resolution {
	if cfg.Endpoint != "" {
		base := strings.TrimRight(cfg.Endpoint, "/")
		warn := ""
		if cfg.ServiceRef != nil {
			warn = "serviceRef ignored because endpoint is set"
		}
		return Resolution{Mode: ModeExplicitEndpoint, Source: base, Transport: tf.Direct(base, cfg.Token, cfg.TLSSkipVerify), Warning: warn}
	}
	if sr := cfg.ServiceRef; sr != nil {
		c := ServiceCandidate{Namespace: sr.Namespace, Name: sr.Name, Port: sr.Port, Scheme: schemeOr(sr.Scheme)}
		return Resolution{Mode: ModeExplicitService, Source: sourceStr(c), Transport: tf.Proxy(c)}
	}
	if disco.MultiMatch {
		return Resolution{Mode: ModeUnavailable, Reason: "multiple candidate Services found, set metrics.serviceRef"}
	}
	if disco.Chosen != nil {
		c := *disco.Chosen
		c.Scheme = schemeOr(c.Scheme)
		return Resolution{Mode: ModeDiscovered, Source: sourceStr(c), Transport: tf.Proxy(c)}
	}
	return Resolution{Mode: ModeUnavailable, Reason: "no Prometheus Service found"}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/metrics/ -run TestResolve -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/metrics/resolve.go internal/metrics/resolve_test.go
git commit -m "feat(metrics): 4-tier endpoint resolution"
```

---

## Task 4: metrics package — transports

**Files:**
- Create: `internal/metrics/transport.go`, `internal/metrics/transport_test.go`

- [ ] **Step 1: Write the failing test**

`internal/metrics/transport_test.go`:

```go
package metrics

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
)

func TestDirectTransport(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path + "?" + r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[1,"1"]}}`))
	}))
	defer srv.Close()

	tr := NewDirectTransport(srv.URL, "tok", srv.Client())
	status, body, err := tr.InstantQuery(context.Background(), "vector(1)")
	if err != nil || status != 200 {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if !strings.HasPrefix(gotPath, "/api/v1/query?query=vector") {
		t.Fatalf("bad path: %s", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("bad auth: %s", gotAuth)
	}
	if !strings.Contains(string(body), "success") {
		t.Fatalf("bad body: %s", body)
	}
}

// captureRT records the outbound request and returns a canned 200.
type captureRT struct{ url string }

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	c.url = r.URL.Path
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       http.NoBody,
	}, nil
}

func TestProxyTransportPath(t *testing.T) {
	rt := &captureRT{}
	cfg := &rest.Config{
		Host:    "https://k8s.test",
		APIPath: "/api",
		ContentConfig: rest.ContentConfig{
			GroupVersion:         &corev1.SchemeGroupVersion,
			NegotiatedSerializer: scheme.Codecs.WithoutConversion(),
		},
		Transport: rt,
	}
	rc, err := rest.RESTClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tr := NewProxyTransport(rc, ServiceCandidate{Namespace: "monitoring", Name: "prometheus-operated", Port: "9090", Scheme: "http"})
	_, _, _ = tr.InstantQuery(context.Background(), "vector(1)")
	want := "/api/v1/namespaces/monitoring/services/http:prometheus-operated:9090/proxy/api/v1/query"
	if rt.url != want {
		t.Fatalf("proxy path:\n got %s\nwant %s", rt.url, want)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/metrics/ -run 'Transport' -v`
Expected: FAIL — `NewDirectTransport`/`NewProxyTransport` undefined.

- [ ] **Step 3: Implement**

`internal/metrics/transport.go`:

```go
package metrics

import (
	"context"
	"io"
	"net/http"
	"net/url"

	"k8s.io/client-go/rest"
)

// directTransport queries an external Prometheus/Mimir base URL over HTTP(S).
type directTransport struct {
	base   string // Prometheus base URL, no trailing /api/v1
	token  string
	client *http.Client
}

// NewDirectTransport builds a direct HTTP transport. The caller supplies the
// *http.Client (with any TLS settings already applied).
func NewDirectTransport(base, token string, client *http.Client) Querier {
	return &directTransport{base: base, token: token, client: client}
}

func (t *directTransport) InstantQuery(ctx context.Context, promql string) (int, []byte, error) {
	u := t.base + "/api/v1/query?query=" + url.QueryEscape(promql)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, nil, err
	}
	if t.token != "" {
		req.Header.Set("Authorization", "Bearer "+t.token)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, body, err
}

// proxyTransport queries through the kube API-server service proxy using the
// cluster's existing REST credentials.
type proxyTransport struct {
	rest rest.Interface
	c    ServiceCandidate
}

// NewProxyTransport builds a proxy transport over a cluster REST client.
func NewProxyTransport(r rest.Interface, c ServiceCandidate) Querier {
	return &proxyTransport{rest: r, c: c}
}

func (t *proxyTransport) InstantQuery(ctx context.Context, promql string) (int, []byte, error) {
	name := schemeOr(t.c.Scheme) + ":" + t.c.Name + ":" + t.c.Port
	var status int
	body, err := t.rest.Get().
		Namespace(t.c.Namespace).
		Resource("services").
		Name(name).
		SubResource("proxy").
		Suffix("api/v1/query").
		Param("query", promql).
		Do(ctx).
		StatusCode(&status).
		Raw()
	if status != 0 {
		return status, body, nil // let the Client interpret non-200
	}
	return status, body, err // genuine transport error (no status); keep any body for diagnostics
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/metrics/ -run 'Transport' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/metrics/transport.go internal/metrics/transport_test.go
git commit -m "feat(metrics): direct + API-server-proxy transports"
```

---

## Task 5: metrics package — probe-confirmed capability

**Files:**
- Create: `internal/metrics/capability.go`, `internal/metrics/capability_test.go`

- [ ] **Step 1: Write the failing test**

`internal/metrics/capability_test.go`:

```go
package metrics

import (
	"context"
	"testing"
)

func TestProbe(t *testing.T) {
	t.Run("unavailable resolution stays unavailable", func(t *testing.T) {
		cap := Probe(context.Background(), Resolution{Mode: ModeUnavailable, Reason: "no Prometheus Service found"})
		if cap.Available || cap.Reason == "" {
			t.Fatalf("got %+v", cap)
		}
	})
	t.Run("live probe passes", func(t *testing.T) {
		q := &fakeQuerier{status: 200, body: `{"status":"success","data":{"resultType":"vector","result":[{"value":[1,"1"]}]}}`}
		cap := Probe(context.Background(), Resolution{Mode: ModeDiscovered, Source: "monitoring/p:9090", Transport: q})
		if !cap.Available || cap.Mode != ModeDiscovered || cap.Source != "monitoring/p:9090" {
			t.Fatalf("got %+v", cap)
		}
	})
	t.Run("probe failure carries the real reason", func(t *testing.T) {
		q := &fakeQuerier{status: 401, body: `unauthorized`}
		cap := Probe(context.Background(), Resolution{Mode: ModeExplicitEndpoint, Source: "https://host", Transport: q})
		if cap.Available || cap.Reason == "" {
			t.Fatalf("got %+v", cap)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/metrics/ -run TestProbe -v`
Expected: FAIL — `Probe` undefined.

- [ ] **Step 3: Implement**

`internal/metrics/capability.go`:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/metrics/ -v`
Expected: PASS (whole package).

- [ ] **Step 5: Commit**

```bash
git add internal/metrics/capability.go internal/metrics/capability_test.go
git commit -m "feat(metrics): probe-confirmed capability"
```

---

## Task 6: Fleet — thread MetricsConfig into ClusterConn

**Files:**
- Modify: `internal/fleet/conn.go`, `internal/fleet/factory.go`
- Modify (callers): any `NewClusterConn(...)` call sites in `internal/fleet/*_test.go`

**Context:** `NewClusterConn` gains a `config.MetricsConfig` parameter. This ripples to the production factory and every test constructor. Do the signature change and caller updates here, with no behaviour yet, so Task 7 adds the method against a stable signature.

- [ ] **Step 1: Update the signature and store the field**

In `internal/fleet/conn.go`, add the import `"github.com/moomora/klyx/internal/config"` (if not present) and a field on `ClusterConn`:

```go
	metricsCfg config.MetricsConfig
```

Change the constructor:

```go
func NewClusterConn(name string, typed kubernetes.Interface, meta metadata.Interface,
	dyn dynamic.Interface, detector *capability.Detector, clk clock.Clock, metricsCfg config.MetricsConfig) *ClusterConn {
	return &ClusterConn{
		name: name, typed: typed, meta: meta, dyn: dyn, detector: detector, clk: clk,
		metricsCfg:     metricsCfg,
		state:          Unconnected,
		connectTimeout: defaultConnectTimeout,
		refresh:        make(chan struct{}, 1),
	}
}
```

- [ ] **Step 2: Thread it through the production factory**

In `internal/fleet/factory.go`, build a value from the pointer and pass it:

```go
		var mc config.MetricsConfig
		if cc.Metrics != nil {
			mc = *cc.Metrics
		}
		det := capability.NewDetector(typed)
		return NewClusterConn(cc.Name, typed, mclient, dyn, det, clk, mc), nil
```

- [ ] **Step 3: Build to find broken callers**

Run: `go build ./... && go vet ./internal/fleet/ 2>&1 | head`
Expected: compile errors at `NewClusterConn(...)` test call sites (missing arg).

- [ ] **Step 4: Fix every test caller**

For each failing `NewClusterConn(...)` call in `internal/fleet/*_test.go`, append `config.MetricsConfig{}` as the final argument and ensure the test file imports `"github.com/moomora/klyx/internal/config"`. Find them with:

Run: `grep -rn "NewClusterConn(" internal/fleet/`

- [ ] **Step 5: Run the fleet tests**

Run: `go test ./internal/fleet/`
Expected: PASS (unchanged behaviour; only the constructor arity changed).

- [ ] **Step 6: Commit**

```bash
git add internal/fleet/conn.go internal/fleet/factory.go internal/fleet/*_test.go
git commit -m "refactor(fleet): thread per-cluster MetricsConfig into ClusterConn"
```

---

## Task 7: Fleet — discovery + ClusterMetrics with asymmetric caching

**Files:**
- Create: `internal/fleet/metrics.go`, `internal/fleet/metrics_test.go`
- Modify: `internal/fleet/conn.go` (cache fields + `Conn` interface)

- [ ] **Step 1: Write the failing test**

`internal/fleet/metrics_test.go`:

```go
package fleet

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/metrics"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func svc(ns, name string, port int32) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: port}}},
	}
}

func TestDiscoverPrefersFirstNamed(t *testing.T) {
	cs := fake.NewSimpleClientset(
		svc("monitoring", "mimir-query-frontend", 8080),
		svc("monitoring", "prometheus-operated", 9090),
	)
	c := &ClusterConn{typed: cs}
	d := c.discover(context.Background())
	if d.MultiMatch || d.Chosen == nil || d.Chosen.Name != "prometheus-operated" {
		t.Fatalf("want prometheus-operated first, got %+v", d.Chosen)
	}
}

func TestDiscoverLabelMultiMatch(t *testing.T) {
	a := svc("ns1", "p1", 9090)
	b := svc("ns2", "p2", 9090)
	for _, s := range []*corev1.Service{a, b} {
		s.Labels = map[string]string{"app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server"}
	}
	cs := fake.NewSimpleClientset(a, b)
	c := &ClusterConn{typed: cs}
	d := c.discover(context.Background())
	if !d.MultiMatch {
		t.Fatalf("want multi-match, got %+v", d)
	}
}

func TestClusterMetricsUnavailableCachesShort(t *testing.T) {
	// No services, no config → unavailable. With a fake clock, the unavailable
	// capability stays cached before its TTL.
	cs := fake.NewSimpleClientset()
	clk := clock.NewFake(time.Unix(0, 0))
	c := &ClusterConn{typed: cs, clk: clk}
	_, cap1 := c.ClusterMetrics(context.Background(), false)
	if cap1.Available || cap1.Mode != metrics.ModeUnavailable {
		t.Fatalf("want unavailable, got %+v", cap1)
	}
	// before TTL: still cached unavailable (no panic, same result)
	_, cap2 := c.ClusterMetrics(context.Background(), false)
	if cap2.Available {
		t.Fatal("should still be unavailable")
	}
}
```

Clock API: `clock.NewFake(t)` returns a `*clock.Fake` whose `Now()` is fixed and which can be advanced with `.Advance(d)` (see `internal/clock/clock.go`).

Note (fake-client label selectors): client-go's fake clientset honours `LabelSelector` via its object tracker, so `TestDiscoverLabelMultiMatch` should pass as written. If it behaves oddly, don't rabbit-hole — the labels on the seeded Services are the only thing that matters; verify they exactly match the selector strings in `labelSelectors` and move on.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run 'Discover|ClusterMetrics' -v`
Expected: FAIL — `discover`/`ClusterMetrics` undefined.

- [ ] **Step 3: Implement the cache fields and interface**

In `internal/fleet/conn.go`, add to the imports `"github.com/moomora/klyx/internal/metrics"`. Add to the `Conn` interface:

```go
	ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability)
```

Add cache fields to `ClusterConn`:

```go
	metricsMu    sync.Mutex
	metricsState metricsCache
```

(Reuse the existing `sync` import.)

- [ ] **Step 4: Implement discovery + caching**

`internal/fleet/metrics.go`:

```go
package fleet

import (
	"context"
	"crypto/tls"
	"net/http"
	"strconv"
	"time"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/metrics"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

const (
	cpuQuery = `1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))`
	memQuery = `1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)`

	metricsSampleTTL      = 15 * time.Second
	metricsUnavailableTTL = 45 * time.Second
	metricsHTTPTimeout    = 3 * time.Second // UI status line must fail fast
)

// namedCandidates is the ranked named-Service probe list. First existing wins;
// ranking is the deliberate tiebreak (prometheus before mimir).
var namedCandidates = []metrics.ServiceCandidate{
	{Namespace: "monitoring", Name: "prometheus-operated", Port: "9090", Scheme: "http"},
	{Namespace: "monitoring", Name: "kube-prometheus-stack-prometheus", Port: "9090", Scheme: "http"},
	{Namespace: "monitoring", Name: "prometheus-server", Port: "80", Scheme: "http"},
	{Namespace: "monitoring", Name: "mimir-query-frontend", Port: "8080", Scheme: "http"},
	{Namespace: "monitoring", Name: "mimir-nginx", Port: "80", Scheme: "http"},
}

// labelSelectors are tried only when NO named candidate exists. A single hit
// with one port is used; multiple hits → multi-match (unavailable).
var labelSelectors = []string{
	"app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server",
	"app.kubernetes.io/name=mimir,app.kubernetes.io/component=query-frontend",
}

type metricsCache struct {
	capSet    bool
	cap       metrics.MetricsCapability
	capExpiry time.Time // zero = cached for lifetime (available)
	transport metrics.Querier

	samples    metrics.ClusterMetrics
	samplesExp time.Time
}

// transportFactory builds real transports from the cluster REST client.
type transportFactory struct{ rest rest.Interface }

func (f transportFactory) Direct(base, token string, skip bool) metrics.Querier {
	tr := &http.Transport{}
	if skip {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // user opt-in
	}
	return metrics.NewDirectTransport(base, token, &http.Client{Transport: tr, Timeout: metricsHTTPTimeout})
}

func (f transportFactory) Proxy(c metrics.ServiceCandidate) metrics.Querier {
	return metrics.NewProxyTransport(f.rest, c)
}

// discover reduces in-cluster Services to a single DiscoveryResult: first
// existing named candidate, else single-hit label fallback, else multi-match
// or none.
func (c *ClusterConn) discover(ctx context.Context) metrics.DiscoveryResult {
	for _, cand := range namedCandidates {
		if _, err := c.typed.CoreV1().Services(cand.Namespace).Get(ctx, cand.Name, metav1.GetOptions{}); err == nil {
			chosen := cand
			return metrics.DiscoveryResult{Chosen: &chosen}
		}
	}
	for _, sel := range labelSelectors {
		list, err := c.typed.CoreV1().Services("").List(ctx, metav1.ListOptions{LabelSelector: sel})
		if err != nil || len(list.Items) == 0 {
			continue
		}
		if len(list.Items) > 1 {
			return metrics.DiscoveryResult{MultiMatch: true}
		}
		s := list.Items[0]
		if len(s.Spec.Ports) != 1 {
			continue // ambiguous port; do not guess
		}
		return metrics.DiscoveryResult{Chosen: &metrics.ServiceCandidate{
			Namespace: s.Namespace, Name: s.Name,
			Port: strconv.Itoa(int(s.Spec.Ports[0].Port)), Scheme: "http",
		}}
	}
	return metrics.DiscoveryResult{}
}

// ClusterMetrics returns the proof-of-life metrics and probe-confirmed
// capability. Lazy resolve+probe on first call; available is cached for the
// conn lifetime, unavailable is short-TTL re-probed, forceReprobe bypasses the
// cache. Sample values cache with their own short TTL.
func (c *ClusterConn) ClusterMetrics(ctx context.Context, forceReprobe bool) (metrics.ClusterMetrics, metrics.MetricsCapability) {
	c.metricsMu.Lock()
	defer c.metricsMu.Unlock()

	clk := c.clk
	if clk == nil { // defensive: manual struct construction in tests
		clk = clock.Real{}
	}
	now := clk.Now()
	capValid := c.metricsState.capSet && !forceReprobe &&
		(c.metricsState.cap.Available || now.Before(c.metricsState.capExpiry))

	if !capValid {
		tf := transportFactory{rest: c.typed.CoreV1().RESTClient()}
		disco := metrics.DiscoveryResult{}
		if c.metricsCfg.Endpoint == "" && c.metricsCfg.ServiceRef == nil {
			disco = c.discover(ctx)
		}
		res := metrics.Resolve(c.metricsCfg, disco, tf)
		cap := metrics.Probe(ctx, res)

		c.metricsState.capSet = true
		c.metricsState.cap = cap
		c.metricsState.transport = res.Transport
		if cap.Available {
			c.metricsState.capExpiry = time.Time{}
		} else {
			c.metricsState.capExpiry = now.Add(metricsUnavailableTTL)
		}
		// re-probe invalidates any cached samples
		c.metricsState.samples = metrics.ClusterMetrics{}
		c.metricsState.samplesExp = time.Time{}
	}

	cap := c.metricsState.cap
	if !cap.Available {
		return metrics.ClusterMetrics{}, cap
	}

	if c.metricsState.samplesExp.IsZero() || now.After(c.metricsState.samplesExp) {
		c.metricsState.samples = querySamples(ctx, c.metricsState.transport)
		c.metricsState.samplesExp = now.Add(metricsSampleTTL)
	}
	return c.metricsState.samples, cap
}

func querySamples(ctx context.Context, q metrics.Querier) metrics.ClusterMetrics {
	cl := metrics.NewClient(q)
	var out metrics.ClusterMetrics
	if s, err := cl.InstantScalar(ctx, cpuQuery); err == nil && !s.Absent {
		v := s.Value
		out.CPUFraction = &v
	}
	if s, err := cl.InstantScalar(ctx, memQuery); err == nil && !s.Absent {
		v := s.Value
		out.MemFraction = &v
	}
	return out
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/fleet/ -run 'Discover|ClusterMetrics' -v && go build ./...`
Expected: PASS, clean build.

- [ ] **Step 6: Run the full fleet + metrics suites with the race detector**

Run: `go test -race ./internal/fleet/ ./internal/metrics/`
Expected: PASS (the cache mutex must be clean under `-race`).

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/metrics.go internal/fleet/metrics_test.go internal/fleet/conn.go
git commit -m "feat(fleet): Prometheus discovery + lazy ClusterMetrics with asymmetric caching"
```

---

## Task 8: Appbridge — MetricsService + DTO, register in main.go

**Files:**
- Create: `internal/appbridge/metrics_service.go`, `internal/appbridge/metrics_dto.go`, `internal/appbridge/metrics_service_test.go`
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Write the failing test**

`internal/appbridge/metrics_service_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGetClusterMetrics -v`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement the service + DTO**

`internal/appbridge/metrics_dto.go`:

```go
package appbridge

// MetricsDTO is the on-demand cluster metrics payload. Nil fractions serialize
// as JSON null (the UI renders "—"), never 0.
type MetricsDTO struct {
	Available   bool     `json:"available"`
	Mode        string   `json:"mode"`
	Source      string   `json:"source"`
	Warning     string   `json:"warning"`
	Reason      string   `json:"reason"`
	CPUFraction *float64 `json:"cpuFraction"`
	MemFraction *float64 `json:"memFraction"`
}
```

`internal/appbridge/metrics_service.go`:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/appbridge/ -run TestGetClusterMetrics -v`
Expected: PASS.

- [ ] **Step 5: Register in main.go**

In `cmd/klyx/main.go`, after the `meshSvc := ...` block, add:

```go
	metricsSvc := appbridge.NewMetricsService(func(name string) (appbridge.MetricsConn, bool) {
		c, ok := reg.Conn(name)
		if !ok {
			return nil, false
		}
		return c, true
	})
```

And add it to the `Services` slice:

```go
			application.NewService(meshSvc),
			application.NewService(metricsSvc),
```

- [ ] **Step 6: Build the binary**

Run: `go build ./...`
Expected: clean (confirms `fleet.Conn` satisfies `appbridge.MetricsConn`).

- [ ] **Step 7: Commit**

```bash
git add internal/appbridge/metrics_service.go internal/appbridge/metrics_dto.go internal/appbridge/metrics_service_test.go cmd/klyx/main.go
git commit -m "feat(appbridge): MetricsService + DTO; register in main"
```

---

## Task 9: Frontend — store slice, bridge, Overview render + refresh; bindings + full verify

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Create: `cmd/klyx/frontend/src/bridge/metrics.ts`
- Modify: `cmd/klyx/frontend/src/cluster/Overview.tsx`, `cmd/klyx/frontend/src/cluster/Overview.test.tsx`

- [ ] **Step 1: Add the store slice + types**

In `cmd/klyx/frontend/src/store/fleet.ts`, add the DTO and slice types near the other DTOs (after `MeshGraphDTO`):

```ts
export type MetricsDTO = { available: boolean; mode: string; source: string; warning: string; reason: string; cpuFraction: number | null; memFraction: number | null };
export type MetricsSlice = { cluster: string | null; dto: MetricsDTO | null; loading: boolean };
```

Add to the `FleetState` type (near `mesh`):

```ts
  metrics: MetricsSlice;
  setMetricsLoading: (cluster: string) => void;
  setMetrics: (cluster: string, dto: MetricsDTO) => void;
  clearMetrics: () => void;
```

Add to the store body (after `setMesh`):

```ts
  metrics: { cluster: null, dto: null, loading: false },
  setMetricsLoading: (cluster) => set((s) => ({ metrics: { cluster, dto: s.metrics.cluster === cluster ? s.metrics.dto : null, loading: true } })),
  setMetrics: (cluster, dto) => set({ metrics: { cluster, dto, loading: false } }),
  clearMetrics: () => set({ metrics: { cluster: null, dto: null, loading: false } }),
```

- [ ] **Step 2: Add the bridge module**

`cmd/klyx/frontend/src/bridge/metrics.ts` — **copy the binding import path verbatim from the existing `bridge/mesh.ts` / `bridge/gateway.ts`** (do not hand-type the path; only the service name `MetricsService` differs):

```ts
import { useFleet, MetricsDTO } from "../store/fleet";
import { MetricsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function getClusterMetrics(cluster: string, forceReprobe: boolean): Promise<void> {
  useFleet.getState().setMetricsLoading(cluster);
  const dto = (await MetricsService.GetClusterMetrics(cluster, forceReprobe)) as MetricsDTO;
  // Ignore a stale response if the user navigated to another cluster.
  if (useFleet.getState().metrics.cluster !== cluster) return;
  useFleet.getState().setMetrics(cluster, dto);
}
```

- [ ] **Step 3: Write the failing Overview test**

Replace `cmd/klyx/frontend/src/cluster/Overview.test.tsx` (or add cases) to cover the metrics rendering. Mock the bridge so no real binding call happens:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { Overview } from "./Overview";
import { useFleet, ClusterDTO, MetricsDTO } from "../store/fleet";

vi.mock("../bridge/metrics", () => ({ getClusterMetrics: vi.fn() }));

const cluster: ClusterDTO = {
  name: "homelab-blue", state: "Synced", reason: "", ageSeconds: 3,
  nodesReady: 3, nodesTotal: 3, pods: 42, version: "v1.30.0",
  env: "", region: "", provider: "", group: "", protected: false,
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
} as ClusterDTO;

function setMetrics(dto: MetricsDTO | null) {
  useFleet.setState({ metrics: { cluster: "homelab-blue", dto, loading: false } });
}

describe("Overview metrics", () => {
  beforeEach(() => useFleet.setState({ metrics: { cluster: null, dto: null, loading: false } }));

  it("renders cpu/mem percents and the discovered monitoring line", () => {
    setMetrics({ available: true, mode: "discovered-service", source: "monitoring/prometheus-operated:9090", warning: "", reason: "", cpuFraction: 0.38, memFraction: 0.61 });
    const { getByText } = render(<Overview c={cluster} />);
    expect(getByText("38%")).toBeTruthy();
    expect(getByText("61%")).toBeTruthy();
    expect(getByText(/monitoring: discovered · svc monitoring\/prometheus-operated:9090/)).toBeTruthy();
  });

  it("renders — for null fractions", () => {
    setMetrics({ available: true, mode: "explicit-endpoint", source: "https://h", warning: "", reason: "", cpuFraction: null, memFraction: null });
    const { getAllByText } = render(<Overview c={cluster} />);
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the unavailable reason", () => {
    setMetrics({ available: false, mode: "unavailable", source: "", warning: "", reason: "multiple candidate Services found, set metrics.serviceRef", cpuFraction: null, memFraction: null });
    const { getByText } = render(<Overview c={cluster} />);
    expect(getByText(/monitoring unavailable: multiple candidate Services found/)).toBeTruthy();
  });
});
```

If the real `ClusterDTO` shape differs from the literal above, copy the existing fixture used in `ClusterDetail.test.tsx` instead of inventing fields — the only fields Overview reads are `name`, `state`, `version`, the tag fields, and the capability/health fields already present.

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/Overview.test.tsx`
Expected: FAIL — Overview renders no metrics yet.

- [ ] **Step 5: Implement the Overview changes**

Modify `cmd/klyx/frontend/src/cluster/Overview.tsx` to add the `useEffect` fetch, the new "Resources" section, and the monitoring line — **preserving the existing layout and the `Badge`/`Section`/`Row` helpers**. Do not restructure unrelated markup. The full file below is the target end state (the only additions vs. the current file are the imports, the `useFleet`/`useEffect` hooks, the `Resources` section, and the `Usage`/`MonitoringLine` helpers):

```tsx
import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import type { ClusterDTO, MetricsDTO } from "../store/fleet";
import { getClusterMetrics } from "../bridge/metrics";
import { stateColor } from "./stateColors";

export function Overview({ c }: { c: ClusterDTO }) {
  const tags = [c.env, c.region, c.provider, c.group].filter(Boolean);
  const metrics = useFleet((s) => s.metrics);
  const loading = useFleet((s) => s.metrics.loading);

  useEffect(() => {
    getClusterMetrics(c.name, false);
    return () => useFleet.getState().clearMetrics();
  }, [c.name]);

  const m: MetricsDTO | null = metrics.cluster === c.name ? metrics.dto : null;

  return (
    <div style={{ padding: "16px 20px", maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor[c.state] ?? "var(--color-text-tertiary)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 15 }}>{c.name}</span>
        {c.version && <Badge>{c.version}</Badge>}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        {tags.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      <Section title="Health">
        <Row label="state"><span style={{ color: stateColor[c.state] }}>{c.state}</span></Row>
        {c.reason && <Row label="reason">{c.reason}</Row>}
        <Row label="age">{c.ageSeconds}s ago</Row>
      </Section>

      <Section title="Capacity">
        <Row label="nodes">{c.nodesReady}/{c.nodesTotal}</Row>
        <Row label="pods">{c.pods}</Row>
      </Section>

      <Section title="Resources">
        <Row label="cpu used"><Usage frac={m?.cpuFraction ?? null} /></Row>
        <Row label="mem used"><Usage frac={m?.memFraction ?? null} /></Row>
        <MonitoringLine dto={m} loading={loading} onRefresh={() => getClusterMetrics(c.name, true)} />
      </Section>

      <Section title="Capabilities">
        <Row label="gitops">{c.gitopsTier}{c.gitopsReason ? ` — ${c.gitopsReason}` : ""}</Row>
        <Row label="network">{c.networkTier}{c.networkReason ? ` — ${c.networkReason}` : ""}</Row>
      </Section>
    </div>
  );
}

function Usage({ frac }: { frac: number | null }) {
  if (frac == null) return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  const pct = Math.round(frac * 100);
  const color = pct >= 90 ? "var(--color-text-danger)" : pct >= 75 ? "var(--color-text-warning)" : "var(--color-text-success)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span>{pct}%</span>
      <span style={{ width: 80, height: 4, background: "var(--color-background-secondary)", borderRadius: 2, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
      </span>
    </span>
  );
}

function MonitoringLine({ dto, loading, onRefresh }: { dto: MetricsDTO | null; loading: boolean; onRefresh: () => void }) {
  let text: string;
  let color = "var(--color-text-tertiary)";
  if (loading && !dto) {
    text = "monitoring: checking…";
  } else if (!dto) {
    text = "monitoring: —";
  } else if (!dto.available) {
    text = `monitoring unavailable: ${dto.reason || "unknown"}`;
    color = "var(--color-text-warning)";
  } else {
    const where = dto.mode === "explicit-endpoint" ? `endpoint ${dto.source}` : `svc ${dto.source}`;
    const label = dto.mode === "discovered-service" ? "discovered" : dto.mode === "explicit-service-ref" ? "service" : "endpoint";
    text = `monitoring: ${label} · ${where}`;
    if (dto.warning) text += ` ⚠ ${dto.warning}`;
  }
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11, alignItems: "center", marginTop: 2 }}>
      <span style={{ color }}>{text}</span>
      <button
        onClick={onRefresh}
        title="re-probe Prometheus"
        style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" }}
      >
        refresh
      </button>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "1px 6px", borderRadius: 4 }}>{children}</span>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--color-text-tertiary)", width: 64 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}
```

- [ ] **Step 6: Run the Overview test + the full vitest suite**

Run: `cd cmd/klyx/frontend && npx vitest run`
Expected: PASS (the new Overview cases plus all existing tests). The `width: 64` Row label is narrow for "cpu used"/"mem used" — if a test or visual check shows truncation, widen the label `width` to 72; do not change the label text.

- [ ] **Step 7: Regenerate bindings + typecheck + build**

Run:
```bash
cd cmd/klyx && wails3 generate bindings && cd frontend && npx tsc --noEmit
```
Expected: bindings include `MetricsService.GetClusterMetrics`; `tsc --noEmit` is clean (the critical frontend gate).

Then the full backend gate from the repo root:
```bash
make test && go test -race ./internal/... && make vet
```
Expected: all PASS.

Then the production build:
```bash
cd cmd/klyx && wails3 build
```
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/bridge/metrics.ts cmd/klyx/frontend/src/cluster/Overview.tsx cmd/klyx/frontend/src/cluster/Overview.test.tsx
git commit -m "feat(ui): cluster Overview cpu/mem used + honest monitoring status line"
```

---

## Native verification (homelab) — after Task 9

Run the app against the live homelab fleet and confirm:

1. `homelab-blue` Overview → real cpu/mem percentages + `monitoring: discovered · svc monitoring/<matched>`. Confirms proxy transport + discovery + parse end-to-end.
2. Pin a deliberately wrong `serviceRef` on one cluster in fleet config → Overview shows `monitoring unavailable: <real proxy error>`, no crash, no fake zeros.
3. A cluster with no Prometheus (e.g. `nelli`) → `monitoring unavailable: no Prometheus Service found`, cpu/mem "—".
4. Restart-recovery: with a cluster showing unavailable, fix the cause (correct config / backend recovers) and click **refresh** → it re-probes and flips to available without restarting the app.
5. (If reachable) set an explicit `endpoint` for one cluster → mode shows `endpoint <host>`, values render.

---

## Self-review notes (author)

- **Spec coverage:** config shape + validation (T1); parsing/liveness (T2); Resolve 4-tier (T3); both transports incl. strict endpoint path (T4); probe capability (T5); config threading (T6); discovery within-stage multi-match + asymmetric caching + queries (T7); DTO/service/registration (T8); store/bridge/Overview/refresh + bindings + full verify (T9). Honesty model (never guess, available=probed, nil≠zero, surface mode, Warning vs Reason) is realized across T2/T3/T5/T7/T9.
- **Multi-cluster scoping** and **AAD auth** are explicitly deferred — no tasks, by design.
- **Type consistency:** `metrics.ClusterMetrics`/`MetricsCapability` are the single types crossing fleet→appbridge (no fleet import in appbridge); `GetClusterMetrics(cluster, forceReprobe)` arity matches store/bridge/Overview; `cpuFraction`/`memFraction` nullable end-to-end.
- **Known caller ripple:** T6 changes `NewClusterConn` arity — Step 4 sweeps every test call site before proceeding.
