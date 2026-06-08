package workloads

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func sel(m map[string]string) *metav1.LabelSelector { return &metav1.LabelSelector{MatchLabels: m} }

func pod(ns, name string, labels map[string]string, ready bool, restarts int32, waiting string) corev1.Pod {
	cs := corev1.ContainerStatus{RestartCount: restarts}
	if waiting != "" {
		cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: waiting}
	} else {
		cs.State.Running = &corev1.ContainerStateRunning{}
	}
	readyCond := corev1.ConditionTrue
	if !ready {
		readyCond = corev1.ConditionFalse
	}
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels, CreationTimestamp: metav1.NewTime(time.Unix(0, 0))},
		Spec:       corev1.PodSpec{NodeName: "node-1"},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: readyCond}},
			ContainerStatuses: []corev1.ContainerStatus{cs},
		},
	}
}

func TestAssembleRankAndJoinAndOwner(t *testing.T) {
	now := time.Unix(600, 0)
	broken := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ollama-prod", Name: "ollama",
			Labels: map[string]string{"kustomize.toolkit.fluxcd.io/name": "ollama", "kustomize.toolkit.fluxcd.io/namespace": "flux-system"}},
		Spec:   appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "ollama"})},
		Status: appsv1.DeploymentStatus{ReadyReplicas: 0},
	}
	healthy := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "monitoring", Name: "grafana"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "grafana"})},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	pods := []corev1.Pod{
		pod("ollama-prod", "ollama-x", map[string]string{"app": "ollama"}, false, 7, "CrashLoopBackOff"),
		pod("monitoring", "grafana-y", map[string]string{"app": "grafana"}, true, 0, ""),
	}

	out := Assemble([]appsv1.Deployment{healthy, broken}, nil, nil, pods, true, now)
	if len(out) != 2 {
		t.Fatalf("want 2, got %d", len(out))
	}
	// Triage: broken first.
	if out[0].Name != "ollama" || out[0].Rank != Unhealthy || out[0].Reason != "CrashLoopBackOff" || out[0].Restarts != 7 {
		t.Fatalf("row0: %+v", out[0])
	}
	if out[0].GitOps == nil || out[0].GitOps.Kind != "Kustomization" || out[0].GitOps.Name != "ollama" {
		t.Fatalf("owner: %+v", out[0].GitOps)
	}
	if len(out[0].Pods) != 1 || out[0].Pods[0].AgeSeconds != 600 {
		t.Fatalf("pods/age: %+v", out[0].Pods)
	}
	if out[1].Name != "grafana" || out[1].Rank != Healthy || out[1].GitOps != nil || out[1].Reason != "Available" {
		t.Fatalf("row1: %+v", out[1])
	}
}

func TestAssembleScaledToZeroAndEmptySelector(t *testing.T) {
	now := time.Unix(0, 0)
	scaled := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "scaled"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(0), Selector: sel(map[string]string{"app": "scaled"})},
		Status:     appsv1.DeploymentStatus{},
	}
	// Empty selector must match ZERO pods (not the whole namespace).
	noSel := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "nosel"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1), Selector: &metav1.LabelSelector{}},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	pods := []corev1.Pod{pod("x", "stray", map[string]string{"app": "whatever"}, true, 3, "")}

	out := Assemble([]appsv1.Deployment{scaled, noSel}, nil, nil, pods, false, now)
	byName := map[string]Workload{}
	for _, w := range out {
		byName[w.Name] = w
	}
	if byName["scaled"].Rank != Healthy || byName["scaled"].Reason != "Scaled to 0" {
		t.Fatalf("scaled: %+v", byName["scaled"])
	}
	if len(byName["nosel"].Pods) != 0 || byName["nosel"].Restarts != 0 {
		t.Fatalf("empty selector matched pods: %+v", byName["nosel"])
	}
}

func TestAssembleInitRestartsCounted(t *testing.T) {
	now := time.Unix(0, 0)
	d := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "initcrash"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "ic"})},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 0},
	}
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "ic-1", Labels: map[string]string{"app": "ic"}},
		Status: corev1.PodStatus{
			Phase:                 corev1.PodPending,
			InitContainerStatuses: []corev1.ContainerStatus{{RestartCount: 9, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}},
		},
	}
	out := Assemble([]appsv1.Deployment{d}, nil, nil, []corev1.Pod{p}, false, now)
	// The reason and the restart count must agree: init crashloop with its restarts.
	if out[0].Reason != "CrashLoopBackOff" || out[0].Restarts != 9 || out[0].Rank != Unhealthy {
		t.Fatalf("init restarts must surface with the reason: %+v", out[0])
	}
}

func TestAssembleDisplayReasonArms(t *testing.T) {
	now := time.Unix(0, 0)
	// Deployment ready<desired, no pod reason, no condition -> Progressing fallback.
	prog := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "prog"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(3), Selector: sel(map[string]string{"app": "prog"})},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1},
	}
	// Healthy StatefulSet -> "Ready" (kind vocabulary).
	sts := appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "db"},
		Spec:       appsv1.StatefulSetSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "db"})},
		Status:     appsv1.StatefulSetStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	out := Assemble([]appsv1.Deployment{prog}, []appsv1.StatefulSet{sts}, nil, nil, false, now)
	byName := map[string]Workload{}
	for _, w := range out {
		byName[w.Name] = w
	}
	if byName["prog"].Reason != "Progressing · 2 unavailable" {
		t.Fatalf("progressing fallback: %q", byName["prog"].Reason)
	}
	if byName["db"].Reason != "Ready" {
		t.Fatalf("sts vocabulary: %q", byName["db"].Reason)
	}
}

func TestAssembleHelmOwner(t *testing.T) {
	now := time.Unix(0, 0)
	d := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "chart",
			Labels: map[string]string{"helm.toolkit.fluxcd.io/name": "grafana", "helm.toolkit.fluxcd.io/namespace": "monitoring"}},
		Spec:   appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "c"})},
		Status: appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	out := Assemble([]appsv1.Deployment{d}, nil, nil, nil, true, now)
	if out[0].GitOps == nil || out[0].GitOps.Kind != "HelmRelease" || out[0].GitOps.Name != "grafana" || out[0].GitOps.Namespace != "monitoring" {
		t.Fatalf("helm owner: %+v", out[0].GitOps)
	}
}

func TestAssembleOverlappingSelectorsDoubleCount(t *testing.T) {
	// Regression-LOCK (known behavior, not desired): overlapping selectors match a
	// shared pod into BOTH workloads. Documents that a future owner-reference join
	// would be a deliberate change. Mirrors Kubernetes label semantics.
	now := time.Unix(0, 0)
	a := appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "a"},
		Spec:       appsv1.StatefulSetSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "web"})},
		Status:     appsv1.StatefulSetStatus{ReadyReplicas: 0},
	}
	b := appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "b"},
		Spec:       appsv1.StatefulSetSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "web", "tier": "api"})},
		Status:     appsv1.StatefulSetStatus{ReadyReplicas: 0},
	}
	shared := pod("x", "shared", map[string]string{"app": "web", "tier": "api"}, false, 2, "CrashLoopBackOff")
	out := Assemble(nil, []appsv1.StatefulSet{a, b}, nil, []corev1.Pod{shared}, false, now)
	byName := map[string]Workload{}
	for _, w := range out {
		byName[w.Name] = w
	}
	// Both workloads see the shared pod (known double-count).
	if len(byName["a"].Pods) != 1 || len(byName["b"].Pods) != 1 {
		t.Fatalf("expected the shared pod under both (known behavior): a=%d b=%d", len(byName["a"].Pods), len(byName["b"].Pods))
	}
}
