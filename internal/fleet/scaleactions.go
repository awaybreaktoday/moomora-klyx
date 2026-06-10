package fleet

import (
	"context"
	"fmt"

	autoscalingv1 "k8s.io/api/autoscaling/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ScaleWorkload sets the replica count on a Deployment or StatefulSet via the
// scale subresource. DaemonSets are not scalable and are rejected. Negative
// replica counts are rejected. kind must be "Deployment" or "StatefulSet".
func (c *ClusterConn) ScaleWorkload(ctx context.Context, kind, namespace, name string, replicas int32) error {
	if replicas < 0 {
		return fmt.Errorf("scale %s %s/%s: replicas must be >= 0, got %d", kind, namespace, name, replicas)
	}
	scale := &autoscalingv1.Scale{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec:       autoscalingv1.ScaleSpec{Replicas: replicas},
	}
	var err error
	switch kind {
	case "Deployment":
		_, err = c.typed.AppsV1().Deployments(namespace).UpdateScale(ctx, name, scale, metav1.UpdateOptions{})
	case "StatefulSet":
		_, err = c.typed.AppsV1().StatefulSets(namespace).UpdateScale(ctx, name, scale, metav1.UpdateOptions{})
	default:
		return fmt.Errorf("unsupported kind %q for scale: must be Deployment or StatefulSet", kind)
	}
	if err != nil {
		return fmt.Errorf("scale %s %s/%s: %w", kind, namespace, name, err)
	}
	return nil
}
