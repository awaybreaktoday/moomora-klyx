package fleet

import (
	"context"
	"io"
	"testing"

	"k8s.io/client-go/kubernetes/fake"
)

// newLogsConn builds a ClusterConn wired only with a fake typed client; the
// fake clientset returns a canned "fake logs" body for GetLogs, which is all we
// need to prove the stream opens, reads, and closes. Real follow/previous
// behaviour is exercised in native verification.
func newLogsConn() *ClusterConn {
	return &ClusterConn{name: "test", typed: fake.NewSimpleClientset()}
}

func TestPodLogStream_OpensReadsCloses(t *testing.T) {
	c := newLogsConn()
	rc, err := c.PodLogStream(context.Background(), "ns", "pod", "app", false, 100)
	if err != nil {
		t.Fatalf("PodLogStream: %v", err)
	}
	defer rc.Close()
	if _, err := io.ReadAll(rc); err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := rc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// Empty container is valid: the API treats "" as the single container. This
// must not panic and must open a stream.
func TestPodLogStream_EmptyContainer(t *testing.T) {
	c := newLogsConn()
	rc, err := c.PodLogStream(context.Background(), "ns", "pod", "", true, 0)
	if err != nil {
		t.Fatalf("PodLogStream empty container: %v", err)
	}
	_ = rc.Close()
}

func TestPodLogStream_TailLinesClamp(t *testing.T) {
	c := newLogsConn()
	// Below floor and above cap should both open without error (the clamp is
	// internal; we assert it never errors at the boundaries).
	for _, tail := range []int64{-1, 0, 10_000} {
		rc, err := c.PodLogStream(context.Background(), "ns", "pod", "app", false, tail)
		if err != nil {
			t.Fatalf("tail=%d: %v", tail, err)
		}
		_ = rc.Close()
	}
}
