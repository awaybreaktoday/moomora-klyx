package metrics

import (
	"context"
	"io"
	"net/http"
	"net/url"

	"k8s.io/client-go/rest"
)

// maxResponseBytes caps a Prometheus response read. Instant-query results are
// kilobytes; this guards against a hostile or misconfigured endpoint.
const maxResponseBytes = 4 << 20 // 4 MiB

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
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
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
