package clustermesh

import (
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

// ParseIdentity reads cluster-name + (optional) cluster-id from cilium-config.
func ParseIdentity(cm *corev1.ConfigMap) Identity {
	if cm == nil {
		return Identity{}
	}
	id := Identity{Name: strings.TrimSpace(cm.Data["cluster-name"])}
	if s, ok := cm.Data["cluster-id"]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			id.ID = &n
		}
	}
	return id
}

// ParsePeers returns the configured remote-cluster names from the
// cilium-clustermesh Secret. A key counts as a peer only when ALL hold:
//   - no dot (filters *.crt/*.key/*.pem and other file-like keys),
//   - not known-internal material (common-*),
//   - its value parses as a remote-cluster config (a YAML doc with a
//     non-empty endpoints list).
//
// The value guard is the real decision - "no dot" alone is a first filter, so a
// future non-cert internal key cannot become a phantom peer.
func ParsePeers(sec *corev1.Secret) []string {
	if sec == nil {
		return nil
	}
	var peers []string
	for k, v := range sec.Data {
		if strings.Contains(k, ".") || strings.HasPrefix(k, "common-") {
			continue
		}
		if !looksLikeClusterConfig(v) {
			continue
		}
		peers = append(peers, k)
	}
	sort.Strings(peers)
	return peers
}

// looksLikeClusterConfig reports whether v is a Cilium remote-cluster etcd-client
// config: it parses as YAML and exposes a non-empty endpoints list. This is robust
// to spacing/quoting, unlike a literal substring check.
func looksLikeClusterConfig(v []byte) bool {
	var cfg struct {
		Endpoints []string `json:"endpoints"`
	}
	if err := yaml.Unmarshal(v, &cfg); err != nil {
		return false
	}
	return len(cfg.Endpoints) > 0
}
