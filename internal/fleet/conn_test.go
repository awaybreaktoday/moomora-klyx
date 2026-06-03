package fleet

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
)

func podMeta(name, ns string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}
}

func TestClusterConnSnapshotCountsAndSyncs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
	)

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme,
		podMeta("p1", "default"), podMeta("p2", "kube-system"))

	det := capability.NewDetector(typed)

	conn := NewClusterConn("plt-sea-prd-we-aks-01", typed, mclient, det, clock.Real{})
	conn.Start(ctx)

	waitFor(t, 2*time.Second, func() bool {
		s := conn.Snapshot()
		return s.State == Synced || s.State == Degraded
	})

	s := conn.Snapshot()
	if s.Name != "plt-sea-prd-we-aks-01" {
		t.Fatalf("want name set, got %q", s.Name)
	}
	if s.NodesReady != 1 || s.NodesTotal != 1 {
		t.Fatalf("want 1/1 nodes, got %d/%d", s.NodesReady, s.NodesTotal)
	}
	if s.Pods != 2 {
		t.Fatalf("want 2 pods, got %d", s.Pods)
	}
	if s.LastSync.IsZero() {
		t.Fatal("want LastSync set after sync")
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", d)
}
