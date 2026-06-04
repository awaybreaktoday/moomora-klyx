package crd

import "strings"

// operatorLabelKeys are checked in priority order; the first non-empty wins.
var operatorLabelKeys = []string{
	"app.kubernetes.io/name",
	"app.kubernetes.io/part-of",
	"helm.sh/chart",
	"app.kubernetes.io/managed-by",
}

// Operator returns a best-effort owning-operator name from CRD labels, or "".
// For helm.sh/chart the trailing "-<version>" is stripped (e.g.
// "cert-manager-v1.14.2" -> "cert-manager").
func Operator(labels map[string]string) string {
	for _, k := range operatorLabelKeys {
		v := labels[k]
		if v == "" {
			continue
		}
		if k == "helm.sh/chart" {
			return stripChartVersion(v)
		}
		return v
	}
	return ""
}

// stripChartVersion removes a trailing "-<version>" segment (a segment whose
// first character is a digit, optionally after a leading "v").
func stripChartVersion(chart string) string {
	i := strings.LastIndex(chart, "-")
	if i < 0 || i == len(chart)-1 {
		return chart
	}
	rest := chart[i+1:]
	rest = strings.TrimPrefix(rest, "v")
	if rest != "" && rest[0] >= '0' && rest[0] <= '9' {
		return chart[:i]
	}
	return chart
}

// categories maps a CRD API group to a curated category badge. Extend by adding
// a line. Unknown groups return "".
var categories = map[string]string{
	"cilium.io":                      "CNI",
	"kustomize.toolkit.fluxcd.io":    "GITOPS",
	"source.toolkit.fluxcd.io":       "GITOPS",
	"helm.toolkit.fluxcd.io":         "GITOPS",
	"notification.toolkit.fluxcd.io": "GITOPS",
	"argoproj.io":                    "GITOPS",
	"cert-manager.io":                "PKI",
	"acme.cert-manager.io":           "PKI",
	"gateway.networking.k8s.io":      "NETWORK",
	"gateway.envoyproxy.io":          "NETWORK",
	"external-secrets.io":            "SECRETS",
	"monitoring.coreos.com":          "OBSERV",
	"postgresql.cnpg.io":             "DATABASE",
}

// Category returns the curated category for a group, or "".
func Category(group string) string { return categories[group] }
