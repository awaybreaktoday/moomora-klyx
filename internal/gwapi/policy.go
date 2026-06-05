package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// PolicyTargets reads spec.targetRefs[] plus the legacy singular spec.targetRef.
// Namespace holds the raw targetRef.namespace (empty when omitted).
func PolicyTargets(u *unstructured.Unstructured) []TargetRef {
	var out []TargetRef
	add := func(m map[string]interface{}) {
		t := TargetRef{}
		t.Group, _ = m["group"].(string)
		t.Kind, _ = m["kind"].(string)
		t.Name, _ = m["name"].(string)
		t.Namespace, _ = m["namespace"].(string)
		t.SectionName, _ = m["sectionName"].(string)
		out = append(out, t)
	}
	refs, _, _ := unstructured.NestedSlice(u.Object, "spec", "targetRefs")
	for _, r := range refs {
		if m, ok := r.(map[string]interface{}); ok {
			add(m)
		}
	}
	if single, ok, _ := unstructured.NestedMap(u.Object, "spec", "targetRef"); ok {
		add(single)
	}
	return out
}
