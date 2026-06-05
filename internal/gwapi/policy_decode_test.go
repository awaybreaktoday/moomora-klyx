package gwapi

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func specObj(kind, name string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     kind,
		"metadata": map[string]interface{}{"name": name},
		"spec":     spec,
	}}
}

func TestDecodeBTPFeaturesAndValues(t *testing.T) {
	u := specObj("BackendTrafficPolicy", "backend-retries", map[string]interface{}{
		"retry":   map[string]interface{}{"numRetries": int64(3), "perRetry": map[string]interface{}{"timeout": "10s"}},
		"timeout": map[string]interface{}{"http": map[string]interface{}{"requestTimeout": "30s"}},
	})
	d := Decode("BackendTrafficPolicy", u)
	if d.Summary != "retries + timeout" {
		t.Fatalf("summary: %q", d.Summary)
	}
	// Summary must be value-free.
	if strings.ContainsAny(d.Summary, "0123456789") {
		t.Fatalf("summary leaked a value: %q", d.Summary)
	}
	// Details carry decoded values in deterministic order.
	want := []PolicyDetail{{"retries", "3"}, {"per try timeout", "10s"}, {"request timeout", "30s"}}
	if len(d.Details) != len(want) {
		t.Fatalf("details: %+v", d.Details)
	}
	for i := range want {
		if d.Details[i] != want[i] {
			t.Fatalf("details[%d] = %+v want %+v", i, d.Details[i], want[i])
		}
	}
}

func TestDecodeSPPresenceOnly(t *testing.T) {
	u := specObj("SecurityPolicy", "edge-auth", map[string]interface{}{
		"jwt":  map[string]interface{}{"providers": []interface{}{}},
		"cors": map[string]interface{}{},
	})
	d := Decode("SecurityPolicy", u)
	if d.Summary != "jwt + cors" {
		t.Fatalf("summary: %q", d.Summary)
	}
}

func TestDecodeFallbackToName(t *testing.T) {
	// Kind known but no recognised feature -> Summary = name, Details empty.
	u := specObj("BackendTrafficPolicy", "mystery", map[string]interface{}{"somethingNew": true})
	d := Decode("BackendTrafficPolicy", u)
	if d.Summary != "mystery" || len(d.Details) != 0 {
		t.Fatalf("known-no-feature fallback: %+v", d)
	}
	// Kind unknown -> Summary = name (defensive drift guard).
	u2 := specObj("WeirdPolicy", "huh", map[string]interface{}{"x": 1})
	if d2 := Decode("WeirdPolicy", u2); d2.Summary != "huh" || len(d2.Details) != 0 {
		t.Fatalf("unknown-kind fallback: %+v", d2)
	}
}

func TestDecodeBTLSAndEEP(t *testing.T) {
	btls := specObj("BackendTLSPolicy", "keycloak-tls", map[string]interface{}{
		"validation": map[string]interface{}{"hostname": "keycloak.svc", "wellKnownCACertificates": "System"},
	})
	d := Decode("BackendTLSPolicy", btls)
	if d.Summary != "hostname + well-known-ca" {
		t.Fatalf("btls summary: %q", d.Summary)
	}
	if d.Details[0] != (PolicyDetail{"hostname", "keycloak.svc"}) {
		t.Fatalf("btls details: %+v", d.Details)
	}

	eep := specObj("EnvoyExtensionPolicy", "ext", map[string]interface{}{
		"extProc": []interface{}{map[string]interface{}{"backendRefs": []interface{}{}}},
	})
	if d := Decode("EnvoyExtensionPolicy", eep); d.Summary != "ext-proc" {
		t.Fatalf("eep summary: %q", d.Summary)
	}
}

func TestDecodeNeverPanicsOnMalformed(t *testing.T) {
	for _, kind := range []string{"ClientTrafficPolicy", "BackendTrafficPolicy", "SecurityPolicy", "EnvoyExtensionPolicy", "BackendTLSPolicy"} {
		u := &unstructured.Unstructured{Object: map[string]interface{}{"kind": kind, "metadata": map[string]interface{}{"name": "x"}, "spec": "not-a-map"}}
		_ = Decode(kind, u) // must not panic
	}
}
