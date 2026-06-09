package fleet

import (
	"context"
	"io"

	corev1 "k8s.io/api/core/v1"
)

const (
	defaultLogTailLines int64 = 500
	maxLogTailLines     int64 = 5000
)

// PodLogStream opens a log stream for one container. follow is forced off for
// previous-container logs (a terminated container's logs are static; the API
// rejects nothing but a follow would just hang). Caller owns Close.
//
// tailLines is clamped: <= 0 defaults to 500, and it is capped at 5000.
func (c *ClusterConn) PodLogStream(ctx context.Context, namespace, pod, container string, previous bool, tailLines int64) (io.ReadCloser, error) {
	if tailLines <= 0 {
		tailLines = defaultLogTailLines
	}
	if tailLines > maxLogTailLines {
		tailLines = maxLogTailLines
	}
	opts := &corev1.PodLogOptions{
		Container:  container,
		Follow:     !previous,
		Previous:   previous,
		TailLines:  &tailLines,
		Timestamps: false,
	}
	return c.typed.CoreV1().Pods(namespace).GetLogs(pod, opts).Stream(ctx)
}
