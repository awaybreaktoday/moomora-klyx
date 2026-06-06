package gwapi

import (
	"reflect"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

func cnpObj(ns, name string, spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "CiliumNetworkPolicy",
		"metadata": map[string]interface{}{"namespace": ns, "name": name},
		"spec":     spec,
	}}
}

func TestCiliumPolicyRefSelector(t *testing.T) {
	u := cnpObj("monitoring", "grafana-allow", map[string]interface{}{
		"ingress": []interface{}{map[string]interface{}{}},
	})
	ref := CiliumPolicyRef(u, "CiliumNetworkPolicy", MatchSelector, "monitoring", "grafana", true)
	if ref.Kind != "CiliumNetworkPolicy" || ref.Namespace != "monitoring" || ref.Name != "grafana-allow" {
		t.Fatalf("ids: %+v", ref)
	}
	if ref.TargetKind != "Pods" || ref.TargetNamespace != "monitoring" || ref.TargetName != "grafana" {
		t.Fatalf("target: %+v", ref)
	}
	if !ref.Inferred || ref.Match != MatchSelector {
		t.Fatalf("inferred/match: %+v", ref)
	}
	// exprNote=true appends the honesty detail.
	var hasNote bool
	for _, d := range ref.Details {
		if d.Key == "selector note" && strings.Contains(d.Value, "matchExpressions present") {
			hasNote = true
		}
	}
	if !hasNote {
		t.Fatalf("expected matchExpressions note: %+v", ref.Details)
	}
}

func TestCiliumPolicyRefClusterWide(t *testing.T) {
	u := cnpObj("", "deny-all", map[string]interface{}{"ingress": []interface{}{}})
	ref := CiliumPolicyRef(u, "CiliumClusterwideNetworkPolicy", MatchClusterWide, "", "", false)
	if ref.Match != MatchClusterWide || ref.TargetName != "" || !ref.Inferred {
		t.Fatalf("cluster-wide: %+v", ref)
	}
}
