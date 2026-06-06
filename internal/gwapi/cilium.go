package gwapi

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// SelectorClass classifies a Cilium endpointSelector AFTER normalization. It is
// kind-agnostic: mapping empty → namespace-wide (CNP) vs cluster-wide (CCNP) is the
// fleet layer's job, since only it knows the policy kind.
type SelectorClass int

const (
	SelectorEmpty           SelectorClass = iota // no usable matchLabels and no matchExpressions
	SelectorLabels                               // usable normalized matchLabels present
	SelectorExpressionsOnly                      // matchExpressions but no usable matchLabels
)

// NormalizeCiliumLabels strips the "k8s:" source prefix and drops known metadata keys
// (io.kubernetes.*, io.cilium.*, reserved:*). Invariant: it NEVER invents a label - it
// only strips known prefixes and drops known metadata; any other key passes through.
func NormalizeCiliumLabels(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		k = strings.TrimPrefix(k, "k8s:")
		switch {
		case strings.HasPrefix(k, "io.kubernetes."),
			strings.HasPrefix(k, "io.cilium."),
			strings.HasPrefix(k, "reserved:"):
			continue
		}
		out[k] = v
	}
	return out
}

// ClassifyCiliumSelector reads an endpointSelector and classifies it post-normalization.
// Returns the class, the normalized matchLabels, and whether matchExpressions is present.
func ClassifyCiliumSelector(endpointSelector map[string]interface{}) (SelectorClass, map[string]string, bool) {
	if endpointSelector == nil {
		return SelectorEmpty, map[string]string{}, false
	}
	raw, _, err := unstructured.NestedStringMap(endpointSelector, "matchLabels")
	if err != nil {
		raw = nil
	}
	labels := NormalizeCiliumLabels(raw)
	exprs, _, _ := unstructured.NestedSlice(endpointSelector, "matchExpressions")
	hasExpr := len(exprs) > 0
	if len(labels) > 0 {
		return SelectorLabels, labels, hasExpr
	}
	if hasExpr {
		return SelectorExpressionsOnly, labels, true
	}
	return SelectorEmpty, labels, false
}

// LabelsSubset reports whether every key/value in labels is present in serviceSelector.
// Empty labels never match (the namespace-wide path handles that case instead).
func LabelsSubset(labels, serviceSelector map[string]string) bool {
	if len(labels) == 0 {
		return false
	}
	for k, v := range labels {
		if serviceSelector[k] != v {
			return false
		}
	}
	return true
}

// CiliumPolicyRef builds an inferred PolicyRef for a CNP/CCNP matched against a Service's
// pods. TargetKind is always "Pods" (Cilium selects endpoints; the Service is the bridge).
// exprNote appends the "matchExpressions present, not fully evaluated" honesty detail.
func CiliumPolicyRef(u *unstructured.Unstructured, kind string, match PolicyMatchKind, targetNS, targetName string, exprNote bool) PolicyRef {
	dec := Decode(kind, u)
	details := append([]PolicyDetail(nil), dec.Details...)
	if exprNote {
		details = append(details, PolicyDetail{Key: "selector note", Value: "matchExpressions present, not fully evaluated"})
	}
	return PolicyRef{
		Kind: kind, Namespace: u.GetNamespace(), Name: u.GetName(),
		TargetKind: "Pods", TargetNamespace: targetNS, TargetName: targetName,
		Summary: dec.Summary, Details: details,
		Inferred: true, Match: match,
	}
}
