package crd

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

// Condition is one status.conditions entry.
type Condition struct {
	Type    string
	Status  string
	Reason  string
	Message string
}

// Event is a describe-style event for an instance.
type Event struct {
	Type    string // Normal | Warning
	Reason  string
	Message string
	Count   int32
	Last    time.Time
}

// InstanceDetail is the full per-instance detail: header, conditions, events, YAML.
type InstanceDetail struct {
	Kind       string
	Namespace  string
	Name       string
	Created    time.Time
	Labels     map[string]string
	Conditions []Condition
	Events     []Event
	YAML       string
}

// ParseConditions maps status.conditions[] (a near-universal convention). Empty
// when the field is absent or not a list of objects.
func ParseConditions(obj map[string]interface{}) []Condition {
	raw, _, _ := unstructured.NestedSlice(obj, "status", "conditions")
	out := make([]Condition, 0, len(raw))
	for _, c := range raw {
		m, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cond := Condition{}
		cond.Type, _ = m["type"].(string)
		cond.Status, _ = m["status"].(string)
		cond.Reason, _ = m["reason"].(string)
		cond.Message, _ = m["message"].(string)
		out = append(out, cond)
	}
	return out
}

// ToYAML marshals an unstructured Object map to kubectl-style YAML.
func ToYAML(obj map[string]interface{}) (string, error) {
	b, err := yaml.Marshal(withoutManagedFields(obj))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// withoutManagedFields returns obj with metadata.managedFields removed, matching
// the modern `kubectl get -o yaml` default (managedFields hidden since 1.21).
// The server-side-apply ownership tree is pure noise in a detail view and buries
// the real spec. Does not mutate the input (shallow-clones the touched maps).
func withoutManagedFields(obj map[string]interface{}) map[string]interface{} {
	md, ok := obj["metadata"].(map[string]interface{})
	if !ok {
		return obj
	}
	if _, has := md["managedFields"]; !has {
		return obj
	}
	out := make(map[string]interface{}, len(obj))
	for k, v := range obj {
		out[k] = v
	}
	nmd := make(map[string]interface{}, len(md))
	for k, v := range md {
		if k == "managedFields" {
			continue
		}
		nmd[k] = v
	}
	out["metadata"] = nmd
	return out
}
