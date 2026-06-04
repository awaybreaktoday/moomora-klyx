// Package flux parses Flux CRDs (read as unstructured) into vocabulary-correct
// reconciliation resources. No Flux Go API dependency: tolerant of version drift.
package flux

import (
	"strings"
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

type Condition struct {
	Type    string
	Status  string
	Reason  string
	Message string
}

type InventoryEntry struct {
	Group     string
	Version   string
	Kind      string
	Namespace string
	Name      string
}

type Detail struct {
	Kind              Kind
	Namespace         string
	Name              string
	AppliedRevision   string
	AttemptedRevision string
	Conditions        []Condition
	Inventory         []InventoryEntry
}

// ParseDetail extracts the detail view from a watched Flux CR. Inventory is
// parsed only for Kustomizations (HelmRelease CRs carry none).
func ParseDetail(u *unstructured.Unstructured) Detail {
	d := Detail{Kind: Kind(u.GetKind()), Namespace: u.GetNamespace(), Name: u.GetName()}
	d.AppliedRevision, _, _ = unstructured.NestedString(u.Object, "status", "lastAppliedRevision")
	d.AttemptedRevision, _, _ = unstructured.NestedString(u.Object, "status", "lastAttemptedRevision")

	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, c := range conds {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cond := Condition{}
		cond.Type, _ = cm["type"].(string)
		cond.Status, _ = cm["status"].(string)
		cond.Reason, _ = cm["reason"].(string)
		cond.Message, _ = cm["message"].(string)
		d.Conditions = append(d.Conditions, cond)
	}

	entries, _, _ := unstructured.NestedSlice(u.Object, "status", "inventory", "entries")
	for _, e := range entries {
		em, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := em["id"].(string)
		v, _ := em["v"].(string)
		if ie, ok := parseInventoryID(id, v); ok {
			d.Inventory = append(d.Inventory, ie)
		}
	}
	return d
}

// parseInventoryID parses Flux's inventory id "<namespace>_<name>_<group>_<kind>".
// Namespace is empty for cluster-scoped objects; group is empty for core kinds.
// k8s names/namespaces/groups/kinds contain no underscore, so a 4-way split is safe.
func parseInventoryID(id, version string) (InventoryEntry, bool) {
	parts := strings.SplitN(id, "_", 4)
	if len(parts) != 4 {
		return InventoryEntry{}, false
	}
	return InventoryEntry{
		Namespace: parts[0],
		Name:      parts[1],
		Group:     parts[2],
		Kind:      parts[3],
		Version:   version,
	}, true
}
