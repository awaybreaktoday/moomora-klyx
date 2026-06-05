package gwapi

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func polObj(kind, ns, name string, targetRefs []interface{}, singleTargetRef map[string]interface{}, spec map[string]interface{}) *unstructured.Unstructured {
	s := map[string]interface{}{}
	for k, v := range spec {
		s[k] = v
	}
	if targetRefs != nil {
		s["targetRefs"] = targetRefs
	}
	if singleTargetRef != nil {
		s["targetRef"] = singleTargetRef
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1",
		"kind":       kind,
		"metadata":   map[string]interface{}{"namespace": ns, "name": name},
		"spec":       s,
	}}
}

func tref(kind, name, ns, section string) map[string]interface{} {
	m := map[string]interface{}{"kind": kind, "name": name, "group": "gateway.networking.k8s.io"}
	if ns != "" {
		m["namespace"] = ns
	}
	if section != "" {
		m["sectionName"] = section
	}
	return m
}

func TestPolicyTargetsPluralAndSingular(t *testing.T) {
	u := polObj("BackendTrafficPolicy", "apps", "btp", []interface{}{
		tref("HTTPRoute", "r1", "", "https"),
		tref("HTTPRoute", "r2", "other", ""),
	}, nil, nil)
	ts := PolicyTargets(u)
	if len(ts) != 2 || ts[0].Kind != "HTTPRoute" || ts[0].Name != "r1" || ts[0].SectionName != "https" {
		t.Fatalf("targets[0]: %+v", ts)
	}
	if ts[1].Namespace != "other" {
		t.Fatalf("targets[1] ns: %+v", ts[1])
	}

	// Legacy singular targetRef.
	u2 := polObj("ClientTrafficPolicy", "infra", "ctp", nil, tref("Gateway", "eg", "", ""), nil)
	ts2 := PolicyTargets(u2)
	if len(ts2) != 1 || ts2[0].Kind != "Gateway" || ts2[0].Name != "eg" {
		t.Fatalf("singular: %+v", ts2)
	}
}
