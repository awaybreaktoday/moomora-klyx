package fleet

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func TestMeshMember(t *testing.T) {
	cfg := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cilium-config", Namespace: "kube-system"},
		Data: map[string]string{"cluster-name": "homelab-blue", "cluster-id": "1"}}
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "cilium-clustermesh", Namespace: "kube-system"},
		Data: map[string][]byte{"homelab-orange": []byte("endpoints:\n- https://x:2379\n")}}
	apiserver := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "clustermesh-apiserver", Namespace: "kube-system"}}
	typed := typedfake.NewSimpleClientset(cfg, sec, apiserver)

	c := NewClusterConn("ctx-blue", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	m, st := c.MeshMember(context.Background())
	if m.Cluster != "ctx-blue" || m.Identity.Name != "homelab-blue" || m.Identity.ID == nil || *m.Identity.ID != 1 {
		t.Fatalf("identity: %+v", m)
	}
	if len(m.Peers) != 1 || m.Peers[0] != "homelab-orange" || !m.Present || !m.Installed {
		t.Fatalf("member: %+v", m)
	}
	if !st.ClusterMeshInstalled || !st.IdentityRead || !st.PeersRead {
		t.Fatalf("status: %+v", st)
	}
}

func TestMeshMemberStandalone(t *testing.T) {
	// No clustermesh secret/apiserver: still returns a usable member (so the cluster stays a fleet node).
	cfg := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cilium-config", Namespace: "kube-system"},
		Data: map[string]string{"cluster-name": "homelab-nelli"}}
	typed := typedfake.NewSimpleClientset(cfg)
	c := NewClusterConn("ctx-nelli", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	m, st := c.MeshMember(context.Background())
	if m.Cluster != "ctx-nelli" || m.Identity.Name != "homelab-nelli" || len(m.Peers) != 0 || m.Installed {
		t.Fatalf("standalone member: %+v", m)
	}
	if st.ClusterMeshInstalled {
		t.Fatalf("status installed should be false: %+v", st)
	}
}

func TestHasGlobalService(t *testing.T) {
	gsvc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "share-api", Namespace: "apps", Annotations: map[string]string{"service.cilium.io/global": "true"}}}
	plain := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "local-only", Namespace: "apps"}}
	typed := typedfake.NewSimpleClientset(gsvc, plain)
	c := NewClusterConn("ctx-orange", typed, nil, nil, nil, clock.Real{}, config.MetricsConfig{})

	if !c.HasGlobalService(context.Background(), "apps", "share-api") {
		t.Fatal("share-api is global")
	}
	if c.HasGlobalService(context.Background(), "apps", "local-only") {
		t.Fatal("local-only is not global")
	}
	if c.HasGlobalService(context.Background(), "apps", "absent") {
		t.Fatal("absent service is not global")
	}
}
