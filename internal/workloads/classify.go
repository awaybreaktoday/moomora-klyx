package workloads

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

// classified holds the per-kind status extraction.
type classified struct {
	desired, ready, available, updated int
	condReason                         string // failure/rollout reason, "" when healthy
}

func replicas(p *int32) int {
	if p == nil {
		return 1
	}
	return int(*p)
}

func classifyDeployment(d *appsv1.Deployment) classified {
	c := classified{
		desired:   replicas(d.Spec.Replicas),
		ready:     int(d.Status.ReadyReplicas),
		available: int(d.Status.AvailableReplicas),
		updated:   int(d.Status.UpdatedReplicas),
	}
	// Condition priority: ReplicaFailure=True > Available=False > Progressing=False
	// > Progressing rolling. Healthy NewReplicaSetAvailable is NOT surfaced.
	var avail, prog *appsv1.DeploymentCondition
	for i := range d.Status.Conditions {
		cond := &d.Status.Conditions[i]
		switch cond.Type {
		case appsv1.DeploymentReplicaFailure:
			if cond.Status == corev1.ConditionTrue {
				c.condReason = cond.Reason
				return c
			}
		case appsv1.DeploymentAvailable:
			avail = cond
		case appsv1.DeploymentProgressing:
			prog = cond
		}
	}
	if avail != nil && avail.Status == corev1.ConditionFalse {
		c.condReason = avail.Reason
		return c
	}
	if prog != nil && prog.Status == corev1.ConditionFalse {
		c.condReason = prog.Reason
		return c
	}
	if prog != nil && prog.Status == corev1.ConditionTrue && prog.Reason != "NewReplicaSetAvailable" {
		c.condReason = fmt.Sprintf("Rolling out · %d updated", c.updated)
	}
	return c
}

func classifyStatefulSet(s *appsv1.StatefulSet) classified {
	c := classified{
		desired:   replicas(s.Spec.Replicas),
		ready:     int(s.Status.ReadyReplicas),
		available: int(s.Status.AvailableReplicas),
		updated:   int(s.Status.UpdatedReplicas),
	}
	if s.Status.CurrentRevision != "" && s.Status.UpdateRevision != "" && s.Status.CurrentRevision != s.Status.UpdateRevision {
		c.condReason = fmt.Sprintf("Rolling out · %d updated", c.updated)
	}
	return c
}

func classifyDaemonSet(ds *appsv1.DaemonSet) classified {
	c := classified{
		desired:   int(ds.Status.DesiredNumberScheduled),
		ready:     int(ds.Status.NumberReady),
		available: int(ds.Status.NumberAvailable),
		updated:   int(ds.Status.UpdatedNumberScheduled),
	}
	if ds.Status.NumberUnavailable > 0 {
		c.condReason = fmt.Sprintf("Degraded · %d unavailable", ds.Status.NumberUnavailable)
	}
	return c
}
