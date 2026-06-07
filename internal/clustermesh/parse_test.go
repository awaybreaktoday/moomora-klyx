package clustermesh

import (
	"os"
	"path/filepath"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

func TestParseIdentity(t *testing.T) {
	id := ParseIdentity(&corev1.ConfigMap{Data: map[string]string{"cluster-name": "homelab-blue", "cluster-id": "1"}})
	if id.Name != "homelab-blue" || id.ID == nil || *id.ID != 1 {
		t.Fatalf("identity: %+v", id)
	}
	// Missing/malformed cluster-id still yields a usable identity by name.
	id2 := ParseIdentity(&corev1.ConfigMap{Data: map[string]string{"cluster-name": "x", "cluster-id": "oops"}})
	if id2.Name != "x" || id2.ID != nil {
		t.Fatalf("malformed id: %+v", id2)
	}
}

func TestParsePeersFixture(t *testing.T) {
	// Build a Secret whose StringData mirrors the real fixture (the cert key must be ignored).
	b, err := os.ReadFile(filepath.Join("testdata", "blue-clustermesh-secret.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]string
	if err := yaml.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	sec := &corev1.Secret{Data: map[string][]byte{}}
	for k, v := range raw {
		sec.Data[k] = []byte(v)
	}
	peers := ParsePeers(sec)
	if len(peers) != 1 || peers[0] != "homelab-orange" {
		t.Fatalf("peers: %+v (cert key must be filtered)", peers)
	}
}

func TestParsePeersFiltersAndNil(t *testing.T) {
	if ParsePeers(nil) != nil {
		t.Fatal("nil secret -> nil")
	}
	sec := &corev1.Secret{Data: map[string][]byte{
		"orange":                    []byte("endpoints:\n- https://x:2379\n"),
		"green.crt":                 []byte("endpoints:"),   // dotted -> filtered even if value matches
		"common-etcd-client-ca.crt": []byte("cert"),         // internal -> filtered
		"weird":                     []byte("not-a-config"), // no endpoints: -> filtered
	}}
	peers := ParsePeers(sec)
	if len(peers) != 1 || peers[0] != "orange" {
		t.Fatalf("peers: %+v", peers)
	}
}
