package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/moomora/klyx/internal/clustermesh"
)

// MeshReadStatus records what the mesh read could and couldn't see (nuance the
// returned Member alone can't carry).
type MeshReadStatus struct {
	ClusterMeshInstalled bool
	IdentityRead         bool
	PeersRead            bool
	Note                 string
}

// MeshMember reads this cluster's Cilium mesh facts (cilium-config + the
// cilium-clustermesh Secret). It ALWAYS returns a usable Member (Present=true)
// even when the Secret is absent, so a standalone cluster still becomes a fleet
// node. Installed is detected via the clustermesh-apiserver Deployment / Secret.
func (c *ClusterConn) MeshMember(ctx context.Context) (clustermesh.Member, MeshReadStatus) {
	m := clustermesh.Member{Cluster: c.name, Present: true}
	var st MeshReadStatus

	if cm, err := c.typed.CoreV1().ConfigMaps("kube-system").Get(ctx, "cilium-config", metav1.GetOptions{}); err == nil {
		m.Identity = clustermesh.ParseIdentity(cm)
		st.IdentityRead = true
	}
	if sec, err := c.typed.CoreV1().Secrets("kube-system").Get(ctx, "cilium-clustermesh", metav1.GetOptions{}); err == nil {
		m.Peers = clustermesh.ParsePeers(sec)
		st.PeersRead = true
		st.ClusterMeshInstalled = true
	} else if _, derr := c.typed.AppsV1().Deployments("kube-system").Get(ctx, "clustermesh-apiserver", metav1.GetOptions{}); derr == nil {
		st.ClusterMeshInstalled = true
	}
	m.Installed = st.ClusterMeshInstalled
	return m, st
}
