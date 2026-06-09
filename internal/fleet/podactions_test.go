package fleet

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	typedfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func newPodActionsConn(typed *typedfake.Clientset, clk clock.Clock) *ClusterConn {
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, nil, det, clk, config.MetricsConfig{})
	c.ctx = context.Background()
	return c
}

func seedPod(ns, name string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}
}

func seedDeployment(ns, name string) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       appsv1.DeploymentSpec{},
	}
}

func seedStatefulSet(ns, name string) *appsv1.StatefulSet {
	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       appsv1.StatefulSetSpec{},
	}
}

func seedDaemonSet(ns, name string) *appsv1.DaemonSet {
	return &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       appsv1.DaemonSetSpec{},
	}
}

// --- DeletePod ---

func TestDeletePod_RemovesPod(t *testing.T) {
	typed := typedfake.NewSimpleClientset(seedPod("default", "web-xyz"))
	c := newPodActionsConn(typed, clock.Real{})

	if err := c.DeletePod(context.Background(), "default", "web-xyz"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}

	// Verify the fake recorded a delete action.
	deleted := false
	for _, a := range typed.Actions() {
		if da, ok := a.(k8stesting.DeleteAction); ok && da.GetName() == "web-xyz" && da.GetResource().Resource == "pods" {
			deleted = true
		}
	}
	if !deleted {
		t.Fatal("expected a delete action on pods/web-xyz")
	}
}

func TestDeletePod_NotFoundPropagates(t *testing.T) {
	typed := typedfake.NewSimpleClientset()
	typed.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "missing")
	})
	c := newPodActionsConn(typed, clock.Real{})

	err := c.DeletePod(context.Background(), "default", "missing")
	if err == nil || !apierrors.IsNotFound(err) {
		t.Fatalf("want NotFound error, got %v", err)
	}
}

// --- RolloutRestart ---

func TestRolloutRestart_Deployment_PatchesAnnotation(t *testing.T) {
	fakeTime := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(fakeTime)
	typed := typedfake.NewSimpleClientset(seedDeployment("default", "api"))
	c := newPodActionsConn(typed, clk)

	if err := c.RolloutRestart(context.Background(), "Deployment", "default", "api"); err != nil {
		t.Fatalf("RolloutRestart: %v", err)
	}

	want := fakeTime.UTC().Format(time.RFC3339)
	patched := false
	for _, a := range typed.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && pa.GetName() == "api" && pa.GetResource().Resource == "deployments" {
			body := string(pa.GetPatch())
			if strings.Contains(body, "restartedAt") && strings.Contains(body, want) {
				patched = true
			}
		}
	}
	if !patched {
		t.Fatalf("expected patch with restartedAt=%s on deployments/api", want)
	}
}

func TestRolloutRestart_StatefulSet_PatchesAnnotation(t *testing.T) {
	fakeTime := time.Date(2026, 6, 10, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFake(fakeTime)
	typed := typedfake.NewSimpleClientset(seedStatefulSet("db", "pg"))
	c := newPodActionsConn(typed, clk)

	if err := c.RolloutRestart(context.Background(), "StatefulSet", "db", "pg"); err != nil {
		t.Fatalf("RolloutRestart StatefulSet: %v", err)
	}

	want := fakeTime.UTC().Format(time.RFC3339)
	patched := false
	for _, a := range typed.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && pa.GetName() == "pg" && pa.GetResource().Resource == "statefulsets" {
			if strings.Contains(string(pa.GetPatch()), want) {
				patched = true
			}
		}
	}
	if !patched {
		t.Fatalf("expected patch on statefulsets/pg with ts=%s", want)
	}
}

func TestRolloutRestart_DaemonSet_PatchesAnnotation(t *testing.T) {
	fakeTime := time.Date(2026, 6, 10, 8, 30, 0, 0, time.UTC)
	clk := clock.NewFake(fakeTime)
	typed := typedfake.NewSimpleClientset(seedDaemonSet("kube-system", "cilium"))
	c := newPodActionsConn(typed, clk)

	if err := c.RolloutRestart(context.Background(), "DaemonSet", "kube-system", "cilium"); err != nil {
		t.Fatalf("RolloutRestart DaemonSet: %v", err)
	}

	want := fakeTime.UTC().Format(time.RFC3339)
	patched := false
	for _, a := range typed.Actions() {
		if pa, ok := a.(k8stesting.PatchAction); ok && pa.GetName() == "cilium" && pa.GetResource().Resource == "daemonsets" {
			if strings.Contains(string(pa.GetPatch()), want) {
				patched = true
			}
		}
	}
	if !patched {
		t.Fatalf("expected patch on daemonsets/cilium with ts=%s", want)
	}
}

func TestRolloutRestart_UnsupportedKindErrors(t *testing.T) {
	c := newPodActionsConn(typedfake.NewSimpleClientset(), clock.Real{})
	err := c.RolloutRestart(context.Background(), "Job", "default", "migrate")
	if err == nil || !strings.Contains(err.Error(), "unsupported kind") {
		t.Fatalf("want unsupported kind error, got %v", err)
	}
}

func TestRolloutRestart_NotFoundPropagates(t *testing.T) {
	typed := typedfake.NewSimpleClientset()
	typed.PrependReactor("patch", "deployments", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "deployments"}, "ghost")
	})
	c := newPodActionsConn(typed, clock.Real{})

	err := c.RolloutRestart(context.Background(), "Deployment", "default", "ghost")
	if err == nil {
		t.Fatal("want error for not-found deployment")
	}
	if !apierrors.IsNotFound(err) && !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("want not-found surfaced, got %v", err)
	}
}

func TestRolloutRestart_NilClockFallsBackToReal(t *testing.T) {
	typed := typedfake.NewSimpleClientset(seedDeployment("ns", "web"))
	// Explicitly pass nil clock - must not panic.
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, nil, det, nil, config.MetricsConfig{})
	c.ctx = context.Background()

	if err := c.RolloutRestart(context.Background(), "Deployment", "ns", "web"); err != nil {
		t.Fatalf("nil clock: %v", err)
	}
}
