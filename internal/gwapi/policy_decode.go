package gwapi

import (
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// PolicyDecoder turns a policy unstructured into a PolicyDecode.
type PolicyDecoder func(u *unstructured.Unstructured) PolicyDecode

var policyDecoders = map[string]PolicyDecoder{
	"ClientTrafficPolicy":  decodeCTP,
	"BackendTrafficPolicy": decodeBTP,
	"SecurityPolicy":       decodeSP,
	"EnvoyExtensionPolicy": decodeEEP,
	"BackendTLSPolicy":     decodeBTLS,
}

// Decode runs the kind's decoder. Fallback ladder: a decoder that finds no
// feature (empty Summary), or an unknown kind, yields Summary = policy name,
// Details = nil. The unknown-kind rung is a defensive drift guard - the fleet
// pass only lists the five known kinds.
func Decode(kind string, u *unstructured.Unstructured) PolicyDecode {
	dec, ok := policyDecoders[kind]
	if !ok {
		return PolicyDecode{Summary: u.GetName()}
	}
	d := dec(u)
	if d.Summary == "" {
		return PolicyDecode{Summary: u.GetName()}
	}
	return d
}

// feat accumulates ordered feature names + decoded detail rows. Summary is built
// from feature names ONLY, so decoded values can never leak into it.
type feat struct {
	features []string
	details  []PolicyDetail
}

func (f *feat) add(name string) { f.features = append(f.features, name) }
func (f *feat) kv(key, val string) {
	if val != "" {
		f.details = append(f.details, PolicyDetail{Key: key, Value: val})
	}
}
func (f *feat) decode() PolicyDecode {
	if len(f.features) == 0 {
		return PolicyDecode{}
	}
	return PolicyDecode{Summary: strings.Join(f.features, " + "), Details: f.details}
}

// specMap returns spec as a map (nil-safe; "spec" may be absent or malformed).
func specMap(u *unstructured.Unstructured) map[string]interface{} {
	m, _, _ := unstructured.NestedMap(u.Object, "spec")
	return m
}

func decodeBTP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	if retry, ok := s["retry"].(map[string]interface{}); ok {
		f.add("retries")
		if n, ok, _ := unstructured.NestedInt64(retry, "numRetries"); ok {
			f.kv("retries", strconv.FormatInt(n, 10))
		}
		if t, _, _ := unstructured.NestedString(retry, "perRetry", "timeout"); t != "" {
			f.kv("per try timeout", t)
		}
	}
	if timeout, ok := s["timeout"].(map[string]interface{}); ok {
		f.add("timeout")
		if t, _, _ := unstructured.NestedString(timeout, "http", "requestTimeout"); t != "" {
			f.kv("request timeout", t)
		}
	}
	if lb, ok := s["loadBalancer"].(map[string]interface{}); ok {
		f.add("load balancer")
		if t, _ := lb["type"].(string); t != "" {
			f.kv("load balancer", t)
		}
	}
	if _, ok := s["circuitBreaker"]; ok {
		f.add("circuit breaker")
	}
	if _, ok := s["rateLimit"]; ok {
		f.add("rate limit")
	}
	return f.decode()
}

func decodeCTP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	if h2, ok := s["http2"].(map[string]interface{}); ok {
		f.add("http2")
		if w, _ := h2["initialStreamWindowSize"].(string); w != "" {
			f.kv("HTTP/2 stream window", w)
		}
	}
	if conn, ok := s["connection"].(map[string]interface{}); ok {
		f.add("connection-limit")
		if v, ok, _ := unstructured.NestedInt64(conn, "connectionLimit", "value"); ok {
			f.kv("max connections", strconv.FormatInt(v, 10))
		}
	}
	if _, ok := s["tls"]; ok {
		f.add("tls")
	}
	if _, ok := s["timeout"]; ok {
		f.add("timeout")
	}
	if _, ok := s["tcpKeepalive"]; ok {
		f.add("keepalive")
	}
	return f.decode()
}

func decodeSP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	s := specMap(u)
	if s == nil {
		return PolicyDecode{}
	}
	// Presence-only: auth intent is ambiguous to decode safely.
	for _, p := range []struct{ key, label string }{
		{"jwt", "jwt"}, {"oidc", "oidc"}, {"extAuth", "ext-auth"},
		{"basicAuth", "basic-auth"}, {"apiKeyAuth", "api-key"},
		{"cors", "cors"}, {"authorization", "authorization"},
	} {
		if _, ok := s[p.key]; ok {
			f.add(p.label)
		}
	}
	return f.decode()
}

func decodeEEP(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	for _, p := range []struct{ key, label string }{
		{"extProc", "ext-proc"}, {"wasm", "wasm"}, {"lua", "lua"},
	} {
		if sl, ok, _ := unstructured.NestedSlice(u.Object, "spec", p.key); ok && len(sl) > 0 {
			f.add(p.label)
		}
	}
	return f.decode()
}

func decodeBTLS(u *unstructured.Unstructured) PolicyDecode {
	var f feat
	val, ok, _ := unstructured.NestedMap(u.Object, "spec", "validation")
	if !ok || val == nil {
		return PolicyDecode{}
	}
	if h, _ := val["hostname"].(string); h != "" {
		f.add("hostname")
		f.kv("hostname", h)
	}
	if _, ok := val["wellKnownCACertificates"]; ok {
		f.add("well-known-ca")
	}
	if ca, ok, _ := unstructured.NestedSlice(val, "caCertificateRefs"); ok && len(ca) > 0 {
		f.add("ca")
	}
	return f.decode()
}
