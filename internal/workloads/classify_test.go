package workloads

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

func i32(n int32) *int32 { return &n }

func TestClassifyDeployment(t *testing.T) {
	d := appsv1.Deployment{
		Spec: appsv1.DeploymentSpec{Replicas: i32(3)},
		Status: appsv1.DeploymentStatus{
			ReadyReplicas: 1, AvailableReplicas: 1, UpdatedReplicas: 3,
			Conditions: []appsv1.DeploymentCondition{
				{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionFalse, Reason: "MinimumReplicasUnavailable"},
				{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionTrue, Reason: "ReplicaSetUpdated"},
			},
		},
	}
	c := classifyDeployment(&d)
	if c.desired != 3 || c.ready != 1 || c.available != 1 || c.updated != 3 {
		t.Fatalf("counts: %+v", c)
	}
	// Available=False wins over a Progressing reason.
	if c.condReason != "MinimumReplicasUnavailable" {
		t.Fatalf("condReason: %q", c.condReason)
	}
}

func TestClassifyDeploymentHealthyNotNoisy(t *testing.T) {
	d := appsv1.Deployment{
		Spec: appsv1.DeploymentSpec{Replicas: i32(2)},
		Status: appsv1.DeploymentStatus{
			ReadyReplicas: 2, AvailableReplicas: 2, UpdatedReplicas: 2,
			Conditions: []appsv1.DeploymentCondition{
				{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionTrue, Reason: "MinimumReplicasAvailable"},
				{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionTrue, Reason: "NewReplicaSetAvailable"},
			},
		},
	}
	c := classifyDeployment(&d)
	// A healthy deployment must NOT surface a noisy Progressing status.
	if c.condReason != "" {
		t.Fatalf("healthy deployment should have empty condReason, got %q", c.condReason)
	}
}

func TestClassifyStatefulSetAndDaemonSet(t *testing.T) {
	s := appsv1.StatefulSet{
		Spec:   appsv1.StatefulSetSpec{Replicas: i32(3)},
		Status: appsv1.StatefulSetStatus{ReadyReplicas: 3, AvailableReplicas: 3, UpdatedReplicas: 3, CurrentRevision: "r1", UpdateRevision: "r1"},
	}
	cs := classifyStatefulSet(&s)
	if cs.desired != 3 || cs.ready != 3 {
		t.Fatalf("sts counts: %+v", cs)
	}

	ds := appsv1.DaemonSet{
		Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: 5, NumberReady: 4, NumberAvailable: 4, UpdatedNumberScheduled: 5, NumberUnavailable: 1},
	}
	cd := classifyDaemonSet(&ds)
	if cd.desired != 5 || cd.ready != 4 || cd.condReason != "Degraded · 1 unavailable" {
		t.Fatalf("ds: %+v", cd)
	}
}
