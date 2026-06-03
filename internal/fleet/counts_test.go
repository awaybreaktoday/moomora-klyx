package fleet

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func node(name string, ready bool) *corev1.Node {
	cond := corev1.NodeCondition{Type: corev1.NodeReady, Status: corev1.ConditionFalse}
	if ready {
		cond.Status = corev1.ConditionTrue
	}
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status:     corev1.NodeStatus{Conditions: []corev1.NodeCondition{cond}},
	}
}

func TestNodeReadiness(t *testing.T) {
	nodes := []*corev1.Node{node("a", true), node("b", true), node("c", false)}
	ready, total := NodeReadiness(nodes)
	if ready != 2 || total != 3 {
		t.Fatalf("want 2/3, got %d/%d", ready, total)
	}
}

func TestNodeReadinessEmpty(t *testing.T) {
	ready, total := NodeReadiness(nil)
	if ready != 0 || total != 0 {
		t.Fatalf("want 0/0, got %d/%d", ready, total)
	}
}
