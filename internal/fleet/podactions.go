package fleet

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/moomora/klyx/internal/clock"
)

// DeletePod deletes one pod. The owning controller (ReplicaSet, StatefulSet,
// DaemonSet) recreates it - this is the standard imperative bounce.
func (c *ClusterConn) DeletePod(ctx context.Context, namespace, name string) error {
	return c.typed.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// RolloutRestart triggers a rolling restart by patching the pod-template
// restartedAt annotation - exactly what kubectl rollout restart does.
// kind must be "Deployment", "StatefulSet", or "DaemonSet".
func (c *ClusterConn) RolloutRestart(ctx context.Context, kind, namespace, name string) error {
	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	ts := clk.Now().UTC().Format(time.RFC3339)

	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{
					"annotations": map[string]interface{}{
						"kubectl.kubernetes.io/restartedAt": ts,
					},
				},
			},
		},
	}
	body, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("rollout restart marshal: %w", err)
	}

	switch kind {
	case "Deployment":
		_, err = c.typed.AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{})
	case "StatefulSet":
		_, err = c.typed.AppsV1().StatefulSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{})
	case "DaemonSet":
		_, err = c.typed.AppsV1().DaemonSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{})
	default:
		return fmt.Errorf("unsupported kind %q: must be Deployment, StatefulSet, or DaemonSet", kind)
	}
	if err != nil {
		return fmt.Errorf("rollout restart %s %s/%s: %w", kind, namespace, name, err)
	}
	return nil
}
