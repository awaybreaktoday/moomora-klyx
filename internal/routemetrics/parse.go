package routemetrics

import "strings"

// parseClusterName extracts "<ns>/<name>" from an Envoy cluster name of the
// exact form httproute/<ns>/<name>/rule/<number>. Any other shape returns
// ok=false (skip, never guess). K8s namespaces/names cannot contain "/", so a
// 5-segment split is unambiguous.
func parseClusterName(name string) (routeKey string, ok bool) {
	parts := strings.Split(name, "/")
	if len(parts) != 5 {
		return "", false
	}
	if parts[0] != "httproute" || parts[3] != "rule" {
		return "", false
	}
	if parts[1] == "" || parts[2] == "" || !isAllDigits(parts[4]) {
		return "", false
	}
	return parts[1] + "/" + parts[2], true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
