package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// condTrue reports whether status.conditions has an entry of the given type with
// status "True".
func condTrue(obj map[string]interface{}, condType string) bool {
	conds, _, _ := unstructured.NestedSlice(obj, "status", "conditions")
	for _, c := range conds {
		m, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t == condType {
			s, _ := m["status"].(string)
			return s == "True"
		}
	}
	return false
}

// ParseGateway maps a Gateway unstructured to a GatewayNode (no routes).
func ParseGateway(u *unstructured.Unstructured) GatewayNode {
	g := GatewayNode{Namespace: u.GetNamespace(), Name: u.GetName()}
	g.ClassName, _, _ = unstructured.NestedString(u.Object, "spec", "gatewayClassName")
	g.Accepted = condTrue(u.Object, "Accepted")
	g.Programmed = condTrue(u.Object, "Programmed")
	ls, _, _ := unstructured.NestedSlice(u.Object, "spec", "listeners")
	for _, l := range ls {
		m, ok := l.(map[string]interface{})
		if !ok {
			continue
		}
		lis := Listener{}
		lis.Name, _ = m["name"].(string)
		lis.Protocol, _ = m["protocol"].(string)
		lis.Hostname, _ = m["hostname"].(string)
		if p, ok, _ := unstructured.NestedNumberAsFloat64(m, "port"); ok {
			lis.Port = int32(p)
		}
		g.Listeners = append(g.Listeners, lis)
	}
	return g
}

// ParseGatewayRef maps a Gateway to the lightweight list item.
func ParseGatewayRef(u *unstructured.Unstructured) GatewayRef {
	cls, _, _ := unstructured.NestedString(u.Object, "spec", "gatewayClassName")
	return GatewayRef{
		Namespace: u.GetNamespace(), Name: u.GetName(), ClassName: cls,
		Accepted: condTrue(u.Object, "Accepted"), Programmed: condTrue(u.Object, "Programmed"),
	}
}
