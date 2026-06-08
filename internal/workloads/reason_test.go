package workloads

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func waitingPod(reason string) corev1.Pod {
	return corev1.Pod{Status: corev1.PodStatus{
		Phase:             corev1.PodRunning,
		ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}},
	}}
}

func TestWorstPodReason(t *testing.T) {
	// CrashLoopBackOff (hard) beats a benign ContainerCreating in another pod.
	r, sev := worstPodReason([]corev1.Pod{waitingPod("ContainerCreating"), waitingPod("CrashLoopBackOff")})
	if r != "CrashLoopBackOff" || sev != sevHard {
		t.Fatalf("got %q/%v", r, sev)
	}

	// OOMKilled in lastState while the container is currently Running -> historical.
	oom := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
		State:                corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled"}},
	}}}}
	r, sev = worstPodReason([]corev1.Pod{oom})
	if r != "OOMKilled" || sev != sevHistorical {
		t.Fatalf("oom got %q/%v", r, sev)
	}

	// Unschedulable from PodScheduled=False.
	pend := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{
		{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable"},
	}}}
	r, sev = worstPodReason([]corev1.Pod{pend})
	if r != "Unschedulable" || sev != sevHard {
		t.Fatalf("pend got %q/%v", r, sev)
	}

	// Unknown waiting reason -> still hard (surface it), but a known hard reason
	// (CrashLoopBackOff) outranks it.
	r, sev = worstPodReason([]corev1.Pod{waitingPod("SomeWeirdNewReason")})
	if r != "SomeWeirdNewReason" || sev != sevHard {
		t.Fatalf("unknown got %q/%v", r, sev)
	}
	r, _ = worstPodReason([]corev1.Pod{waitingPod("SomeWeirdNewReason"), waitingPod("CrashLoopBackOff")})
	if r != "CrashLoopBackOff" {
		t.Fatalf("known should outrank unknown, got %q", r)
	}

	// Clean pod -> none.
	clean := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}}}
	r, sev = worstPodReason([]corev1.Pod{clean})
	if r != "" || sev != sevNone {
		t.Fatalf("clean got %q/%v", r, sev)
	}

	// Empty pod set -> none.
	if r, sev := worstPodReason(nil); r != "" || sev != sevNone {
		t.Fatalf("empty got %q/%v", r, sev)
	}
}

func initFailPod(initReason, mainWaiting string) corev1.Pod {
	main := corev1.ContainerStatus{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: mainWaiting}}}
	if mainWaiting == "" {
		main = corev1.ContainerStatus{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}
	}
	return corev1.Pod{Status: corev1.PodStatus{
		Phase:                 corev1.PodPending,
		InitContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: initReason}}}},
		ContainerStatuses:     []corev1.ContainerStatus{main},
	}}
}

func TestWorstPodReasonInitContainers(t *testing.T) {
	// Failing init container must surface over a benign main PodInitializing.
	r, sev := worstPodReason([]corev1.Pod{initFailPod("CrashLoopBackOff", "PodInitializing")})
	if r != "CrashLoopBackOff" || sev != sevHard {
		t.Fatalf("init crashloop: got %q/%v", r, sev)
	}
	// Init ImagePullBackOff with no main container statuses yet.
	pod := corev1.Pod{Status: corev1.PodStatus{
		Phase:                 corev1.PodPending,
		InitContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff"}}}},
	}}
	if r, sev := worstPodReason([]corev1.Pod{pod}); r != "ImagePullBackOff" || sev != sevHard {
		t.Fatalf("init imagepull: got %q/%v", r, sev)
	}
	// A SUCCESSFULLY completed init container (Terminated Completed) + running main
	// must NOT be flagged.
	done := corev1.Pod{Status: corev1.PodStatus{
		Phase:                 corev1.PodRunning,
		InitContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed", ExitCode: 0}}}},
		ContainerStatuses:     []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
	}}
	if r, sev := worstPodReason([]corev1.Pod{done}); r != "" || sev != sevNone {
		t.Fatalf("completed init should be clean: got %q/%v", r, sev)
	}
}
