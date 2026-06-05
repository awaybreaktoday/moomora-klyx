package gwapi

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func hrObj(name, ns string, parentRefs, rules, statusParents, hostnames []interface{}) *unstructured.Unstructured {
	spec := map[string]interface{}{"parentRefs": parentRefs, "rules": rules}
	if hostnames != nil {
		spec["hostnames"] = hostnames
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"spec":       spec,
		"status":     map[string]interface{}{"parents": statusParents},
	}}
}

func parentRef(name, ns, section string) map[string]interface{} {
	m := map[string]interface{}{"name": name}
	if ns != "" {
		m["namespace"] = ns
	}
	if section != "" {
		m["sectionName"] = section
	}
	return m
}

func statusParent(name, ns string, accepted, resolved string) map[string]interface{} {
	pr := map[string]interface{}{"name": name}
	if ns != "" {
		pr["namespace"] = ns
	}
	return map[string]interface{}{
		"parentRef": pr,
		"conditions": []interface{}{
			map[string]interface{}{"type": "Accepted", "status": accepted},
			map[string]interface{}{"type": "ResolvedRefs", "status": resolved},
		},
	}
}

func rule(path, method, backend string, port, weight int64) map[string]interface{} {
	return map[string]interface{}{
		"matches": []interface{}{map[string]interface{}{
			"path":   map[string]interface{}{"type": "PathPrefix", "value": path},
			"method": method,
		}},
		"backendRefs": []interface{}{map[string]interface{}{
			"name": backend, "port": port, "weight": weight,
		}},
	}
}

func TestRouteForGatewayAttachesAndScopesStatus(t *testing.T) {
	// Route in ns "apps" attaches to Gateway "eg" in ns "infra" (cross-namespace),
	// accepted by THIS gateway but rejected by another parent.
	u := hrObj("share", "apps",
		[]interface{}{
			parentRef("eg", "infra", ""),
			parentRef("other-gw", "infra", ""),
		},
		[]interface{}{rule("/api/share", "GET", "share-api", 8080, 100)},
		[]interface{}{
			statusParent("eg", "infra", "True", "True"),
			statusParent("other-gw", "infra", "False", "True"), // rejected by the other
		},
		[]interface{}{"share.example.com"})

	rn, ok := RouteForGateway(u, "infra", "eg")
	if !ok {
		t.Fatal("route should attach to infra/eg")
	}
	if !rn.Accepted || !rn.ResolvedRefs {
		t.Fatalf("status must be scoped to infra/eg (accepted): %+v", rn)
	}
	if rn.Name != "share" || rn.Namespace != "apps" {
		t.Fatalf("ids: %+v", rn)
	}
	if len(rn.Hostnames) != 1 || rn.Hostnames[0] != "share.example.com" {
		t.Fatalf("hostnames: %+v", rn.Hostnames)
	}
	if len(rn.Matches) != 1 || rn.Matches[0].PathValue != "/api/share" || rn.Matches[0].Method != "GET" {
		t.Fatalf("matches: %+v", rn.Matches)
	}
	if len(rn.Backends) != 1 || rn.Backends[0].Name != "share-api" || rn.Backends[0].Port != 8080 || rn.Backends[0].Weight != 100 {
		t.Fatalf("backends: %+v", rn.Backends)
	}
	// Backend namespace defaults to the route's namespace when omitted.
	if rn.Backends[0].Namespace != "apps" {
		t.Fatalf("backend ns default: %+v", rn.Backends[0])
	}
}

func TestRouteForGatewayParentRefNamespaceDefaultsToRoute(t *testing.T) {
	// parentRef without a namespace defaults to the route's namespace.
	u := hrObj("r", "infra",
		[]interface{}{parentRef("eg", "", "")}, // no namespace
		[]interface{}{rule("/", "", "svc", 80, 0)},
		[]interface{}{statusParent("eg", "", "True", "True")},
		nil)
	if _, ok := RouteForGateway(u, "infra", "eg"); !ok {
		t.Fatal("parentRef ns should default to route ns (infra)")
	}
	if _, ok := RouteForGateway(u, "other", "eg"); ok {
		t.Fatal("must not attach to a gateway in a different namespace")
	}
}

func TestRouteForGatewayNotAttached(t *testing.T) {
	u := hrObj("r", "apps",
		[]interface{}{parentRef("some-other", "apps", "")},
		[]interface{}{rule("/", "", "svc", 80, 0)},
		nil, nil)
	if _, ok := RouteForGateway(u, "apps", "eg"); ok {
		t.Fatal("should not attach")
	}
}
