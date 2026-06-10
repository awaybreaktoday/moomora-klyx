package fleet

import (
	"context"
	"reflect"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	typedfake "k8s.io/client-go/kubernetes/fake"
)

func TestWorkloadPods_SelectorMatch(t *testing.T) {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "web"},
		Spec:       appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}},
	}
	mkPod := func(ns, name string, labels map[string]string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels}}
	}
	cs := typedfake.NewSimpleClientset(
		dep,
		mkPod("team", "web-7d4b9c6f9-x2x9k", map[string]string{"app": "web"}),
		mkPod("team", "web-7d4b9c6f9-aaaaa", map[string]string{"app": "web"}),
		mkPod("team", "other-1", map[string]string{"app": "other"}),
		mkPod("elsewhere", "web-otherns", map[string]string{"app": "web"}), // different namespace
	)
	c := &ClusterConn{typed: cs}

	got, err := c.WorkloadPods(context.Background(), "Deployment", "team", "web")
	if err != nil {
		t.Fatalf("WorkloadPods: %v", err)
	}
	// Sorted, only the two matching the selector in the team namespace.
	want := []string{"web-7d4b9c6f9-aaaaa", "web-7d4b9c6f9-x2x9k"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestWorkloadPods_EmptySelectorZeroPods(t *testing.T) {
	// Selector nil -> zero pods (never the whole namespace).
	ss := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "db"},
		Spec:       appsv1.StatefulSetSpec{Selector: nil},
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "db-0", Labels: map[string]string{"app": "db"}}}
	cs := typedfake.NewSimpleClientset(ss, pod)
	c := &ClusterConn{typed: cs}

	got, err := c.WorkloadPods(context.Background(), "StatefulSet", "team", "db")
	if err != nil {
		t.Fatalf("WorkloadPods: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty selector must match zero pods, got %v", got)
	}
}

func TestWorkloadPods_NotFound(t *testing.T) {
	cs := typedfake.NewSimpleClientset()
	c := &ClusterConn{typed: cs}
	_, err := c.WorkloadPods(context.Background(), "Deployment", "team", "missing")
	if err == nil {
		t.Fatal("want not-found error for missing workload")
	}
}

func TestWorkloadPods_UnknownKind(t *testing.T) {
	cs := typedfake.NewSimpleClientset()
	c := &ClusterConn{typed: cs}
	_, err := c.WorkloadPods(context.Background(), "ReplicaSet", "team", "x")
	if err == nil || !strings.Contains(err.Error(), "unsupported kind") {
		t.Fatalf("want unsupported-kind error, got %v", err)
	}
}

func TestWorkloadPods_DaemonSet(t *testing.T) {
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "cilium"},
		Spec:       appsv1.DaemonSetSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"k8s-app": "cilium"}}},
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "cilium-zzz", Labels: map[string]string{"k8s-app": "cilium"}}}
	cs := typedfake.NewSimpleClientset(ds, pod)
	c := &ClusterConn{typed: cs}

	got, err := c.WorkloadPods(context.Background(), "DaemonSet", "kube-system", "cilium")
	if err != nil {
		t.Fatalf("WorkloadPods: %v", err)
	}
	if len(got) != 1 || got[0] != "cilium-zzz" {
		t.Fatalf("got %v", got)
	}
}
