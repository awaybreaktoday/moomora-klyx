package gwapi

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// RouteForGateway parses an HTTPRoute and, if it attaches to the given Gateway
// (by parentRef, namespace defaulting to the route's), returns the RouteNode with
// Accepted/ResolvedRefs scoped to THAT parent. ok=false when it does not attach.
// Services/Pods are filled later by the fleet layer.
func RouteForGateway(u *unstructured.Unstructured, gwNamespace, gwName string) (RouteNode, bool) {
	routeNS := u.GetNamespace()

	parents, _, _ := unstructured.NestedSlice(u.Object, "spec", "parentRefs")
	attached := false
	for _, p := range parents {
		m, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		ns, _ := m["namespace"].(string)
		if ns == "" {
			ns = routeNS
		}
		// kind defaults to Gateway; group to gateway.networking.k8s.io.
		kind, _ := m["kind"].(string)
		if kind != "" && kind != "Gateway" {
			continue
		}
		if name == gwName && ns == gwNamespace {
			attached = true
			break
		}
	}
	if !attached {
		return RouteNode{}, false
	}

	rn := RouteNode{Namespace: routeNS, Name: u.GetName()}
	rn.Hostnames, _, _ = unstructured.NestedStringSlice(u.Object, "spec", "hostnames")

	rules, _, _ := unstructured.NestedSlice(u.Object, "spec", "rules")
	for _, r := range rules {
		rm, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		matches, _, _ := unstructured.NestedSlice(rm, "matches")
		for _, mt := range matches {
			mm, ok := mt.(map[string]interface{})
			if !ok {
				continue
			}
			match := Match{}
			match.Method, _ = mm["method"].(string)
			if pth, ok := mm["path"].(map[string]interface{}); ok {
				match.PathType, _ = pth["type"].(string)
				match.PathValue, _ = pth["value"].(string)
			}
			rn.Matches = append(rn.Matches, match)
		}
		brefs, _, _ := unstructured.NestedSlice(rm, "backendRefs")
		for _, b := range brefs {
			bm, ok := b.(map[string]interface{})
			if !ok {
				continue
			}
			be := Backend{}
			be.Name, _ = bm["name"].(string)
			be.Kind, _ = bm["kind"].(string)
			if be.Kind == "" {
				be.Kind = "Service"
			}
			be.Namespace, _ = bm["namespace"].(string)
			if be.Namespace == "" {
				be.Namespace = routeNS
			}
			if p, ok := bm["port"].(int64); ok {
				be.Port = int32(p)
			}
			if w, ok := bm["weight"].(int64); ok {
				be.Weight = int32(w)
			}
			rn.Backends = append(rn.Backends, be)
		}
	}

	// Scope status to this Gateway's parent entry.
	rn.Accepted, rn.ResolvedRefs = parentStatus(u.Object, gwNamespace, gwName, routeNS)
	return rn, true
}

// parentStatus reads status.parents[] and returns Accepted/ResolvedRefs for the
// entry whose parentRef matches the given Gateway (namespace defaulting to the
// route's). Returns false,false when no matching parent status exists yet.
func parentStatus(obj map[string]interface{}, gwNamespace, gwName, routeNS string) (accepted, resolved bool) {
	sps, _, _ := unstructured.NestedSlice(obj, "status", "parents")
	for _, sp := range sps {
		spm, ok := sp.(map[string]interface{})
		if !ok {
			continue
		}
		pr, ok := spm["parentRef"].(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := pr["name"].(string)
		ns, _ := pr["namespace"].(string)
		if ns == "" {
			ns = routeNS
		}
		if name != gwName || ns != gwNamespace {
			continue
		}
		conds, _, _ := unstructured.NestedSlice(spm, "conditions")
		for _, c := range conds {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			t, _ := cm["type"].(string)
			s, _ := cm["status"].(string)
			switch t {
			case "Accepted":
				accepted = s == "True"
			case "ResolvedRefs":
				resolved = s == "True"
			}
		}
		return accepted, resolved
	}
	return false, false
}
