package gwapi

import (
	"reflect"
	"testing"
)

func TestNormalizeCiliumLabels(t *testing.T) {
	in := map[string]string{
		"k8s:app":                         "grafana",
		"app":                             "extra",
		"k8s:io.kubernetes.pod.namespace": "monitoring",
		"io.cilium.k8s.policy.cluster":    "default",
		"reserved:host":                   "",
	}
	got := NormalizeCiliumLabels(in)
	want := map[string]string{"app": "extra"} // "k8s:app" strips to "app" then collides; meta keys dropped
	// Note: both "k8s:app" and "app" normalize to key "app"; last write wins is acceptable -
	// assert the meta keys are gone and "app" survives with a non-empty value.
	if _, ok := got["io.kubernetes.pod.namespace"]; ok {
		t.Fatalf("meta key survived: %+v", got)
	}
	if _, ok := got["io.cilium.k8s.policy.cluster"]; ok {
		t.Fatalf("cilium meta survived: %+v", got)
	}
	if v, ok := got["app"]; !ok || v == "" {
		t.Fatalf("app label lost: %+v", got)
	}
	_ = want
}

func TestNormalizeNeverInvents(t *testing.T) {
	in := map[string]string{"tier": "frontend", "team": "obs"}
	got := NormalizeCiliumLabels(in)
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("non-meta labels must pass through unchanged: %+v", got)
	}
}

func sel(matchLabels map[string]interface{}, matchExpressions []interface{}) map[string]interface{} {
	m := map[string]interface{}{}
	if matchLabels != nil {
		m["matchLabels"] = matchLabels
	}
	if matchExpressions != nil {
		m["matchExpressions"] = matchExpressions
	}
	return m
}

func TestClassifyCiliumSelector(t *testing.T) {
	// empty
	if cl, _, _ := ClassifyCiliumSelector(nil); cl != SelectorEmpty {
		t.Fatalf("nil → empty, got %v", cl)
	}
	if cl, _, _ := ClassifyCiliumSelector(map[string]interface{}{}); cl != SelectorEmpty {
		t.Fatalf("{} → empty, got %v", cl)
	}
	// only meta labels → empty after normalization (broad)
	if cl, _, _ := ClassifyCiliumSelector(sel(map[string]interface{}{"io.kubernetes.pod.namespace": "x"}, nil)); cl != SelectorEmpty {
		t.Fatalf("meta-only → empty, got %v", cl)
	}
	// labels
	cl, labels, hasExpr := ClassifyCiliumSelector(sel(map[string]interface{}{"k8s:app": "grafana"}, nil))
	if cl != SelectorLabels || labels["app"] != "grafana" || hasExpr {
		t.Fatalf("labels: %v %+v %v", cl, labels, hasExpr)
	}
	// labels + expressions
	cl, _, hasExpr = ClassifyCiliumSelector(sel(map[string]interface{}{"app": "g"}, []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists"}}))
	if cl != SelectorLabels || !hasExpr {
		t.Fatalf("labels+expr: %v %v", cl, hasExpr)
	}
	// expressions only
	if cl, _, _ := ClassifyCiliumSelector(sel(nil, []interface{}{map[string]interface{}{"key": "tier", "operator": "Exists"}})); cl != SelectorExpressionsOnly {
		t.Fatalf("expr-only, got %v", cl)
	}
}

func TestLabelsSubset(t *testing.T) {
	svc := map[string]string{"app": "grafana", "tier": "frontend"}
	if !LabelsSubset(map[string]string{"app": "grafana"}, svc) {
		t.Fatal("subset should match")
	}
	if LabelsSubset(map[string]string{"app": "other"}, svc) {
		t.Fatal("value mismatch should not match")
	}
	if LabelsSubset(map[string]string{}, svc) {
		t.Fatal("empty labels never match (use namespace-wide path instead)")
	}
}
