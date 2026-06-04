// Package flux parses Flux CRDs (read as unstructured) into vocabulary-correct
// reconciliation resources. No Flux Go API dependency: tolerant of version drift.
package flux

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type Kind string

const (
	KustomizationKind Kind = "Kustomization"
	HelmReleaseKind   Kind = "HelmRelease"
)

type ReadyState string

const (
	Ready       ReadyState = "Ready"
	Reconciling ReadyState = "Reconciling"
	Failed      ReadyState = "Failed"
	Unknown     ReadyState = "Unknown"
)

// Resource is a Flux-managed object's reconciliation state.
type Resource struct {
	Kind        Kind
	Namespace   string
	Name        string
	Ready       ReadyState
	Message     string
	Revision    string
	LastApplied time.Time
	Suspended   bool
	SourceKind  string
	SourceName  string
}

func ParseKustomization(u *unstructured.Unstructured) Resource {
	r := common(u, KustomizationKind)
	r.Revision, _, _ = unstructured.NestedString(u.Object, "status", "lastAppliedRevision")
	return r
}

func ParseHelmRelease(u *unstructured.Unstructured) Resource {
	r := common(u, HelmReleaseKind)
	if rev, ok, _ := unstructured.NestedString(u.Object, "status", "lastAppliedRevision"); ok && rev != "" {
		r.Revision = rev
	} else if hist, ok, _ := unstructured.NestedSlice(u.Object, "status", "history"); ok && len(hist) > 0 {
		if last, ok := hist[len(hist)-1].(map[string]interface{}); ok {
			if cv, ok := last["chartVersion"].(string); ok {
				r.Revision = cv
			}
		}
	}
	if r.SourceName == "" {
		if n, ok, _ := unstructured.NestedString(u.Object, "spec", "chart", "spec", "sourceRef", "name"); ok && n != "" {
			r.SourceName = n
			r.SourceKind, _, _ = unstructured.NestedString(u.Object, "spec", "chart", "spec", "sourceRef", "kind")
		} else if n, ok, _ := unstructured.NestedString(u.Object, "spec", "chartRef", "name"); ok && n != "" {
			r.SourceName = n
			r.SourceKind, _, _ = unstructured.NestedString(u.Object, "spec", "chartRef", "kind")
		}
	}
	return r
}

func common(u *unstructured.Unstructured, kind Kind) Resource {
	r := Resource{Kind: kind, Name: u.GetName(), Namespace: u.GetNamespace()}
	if susp, ok, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); ok {
		r.Suspended = susp
	}
	if k, ok, _ := unstructured.NestedString(u.Object, "spec", "sourceRef", "kind"); ok {
		r.SourceKind = k
	}
	if n, ok, _ := unstructured.NestedString(u.Object, "spec", "sourceRef", "name"); ok {
		r.SourceName = n
	}
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	reconciling := false
	r.Ready = Unknown
	for _, c := range conds {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		ctype, _ := cm["type"].(string)
		cstatus, _ := cm["status"].(string)
		switch ctype {
		case "Ready":
			switch cstatus {
			case "True":
				r.Ready = Ready
			case "False":
				r.Ready = Failed
			}
			if msg, ok := cm["message"].(string); ok {
				r.Message = msg
			}
			if lt, ok := cm["lastTransitionTime"].(string); ok {
				if t, err := time.Parse(time.RFC3339, lt); err == nil {
					r.LastApplied = t
				}
			}
		case "Reconciling":
			if cstatus == "True" {
				reconciling = true
			}
		}
	}
	if reconciling && r.Ready != Failed {
		r.Ready = Reconciling
	}
	return r
}
