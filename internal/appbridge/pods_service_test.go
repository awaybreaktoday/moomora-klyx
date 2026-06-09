package appbridge

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/crd"
	"github.com/moomora/klyx/internal/fleet"
	"github.com/moomora/klyx/internal/workloads"
)

// fakePodConn satisfies PodsConn without importing the real fleet.ClusterConn.
type fakePodConn struct {
	pods   []workloads.PodSummary
	detail fleet.PodDetail
	detErr error
}

func (f *fakePodConn) ListPods(_ context.Context, _ string) ([]workloads.PodSummary, error) {
	return f.pods, nil
}

func (f *fakePodConn) PodDetail(_ context.Context, _, _ string) (fleet.PodDetail, error) {
	return f.detail, f.detErr
}

// --- ListPods tests ---

func TestPodsService_ClusterMiss_NonNilEmpties(t *testing.T) {
	svc := NewPodsService(func(string) (PodsConn, bool) { return nil, false })
	dto := svc.ListPods("nope", "")
	if dto.Pods == nil || dto.Namespaces == nil {
		t.Fatal("slices must be non-nil on cluster miss")
	}
	if len(dto.Pods) != 0 || len(dto.Namespaces) != 0 {
		t.Fatalf("want empty slices, got pods=%d ns=%d", len(dto.Pods), len(dto.Namespaces))
	}
}

func TestPodsService_ListPods_MappingAndRankString(t *testing.T) {
	pods := []workloads.PodSummary{
		{
			Namespace: "b", Name: "crash", Ready: false,
			Phase: "Running", Reason: "CrashLoopBackOff",
			Rank: workloads.Unhealthy, Restarts: 5,
			Node: "n1", IP: "10.0.0.1",
			OwnerKind: "ReplicaSet", OwnerName: "crash-rs",
			AgeSeconds: 60,
			Containers: []workloads.ContainerSummary{
				{Name: "app", Image: "app:1", Ready: false, Restarts: 5, State: "waiting:CrashLoopBackOff"},
			},
		},
		{
			Namespace: "a", Name: "web", Ready: true,
			Phase: "Running", Rank: workloads.Healthy,
			Node: "n2", IP: "10.0.0.2", AgeSeconds: 120,
			Containers: []workloads.ContainerSummary{
				{Name: "web", Image: "nginx:1", Ready: true, State: "running"},
			},
		},
	}
	conn := &fakePodConn{pods: pods}
	svc := NewPodsService(func(string) (PodsConn, bool) { return conn, true })

	all := svc.ListPods("c", "")
	if len(all.Pods) != 2 {
		t.Fatalf("want 2 pods, got %d", len(all.Pods))
	}
	// Rank as string.
	if all.Pods[0].Rank != "unhealthy" {
		t.Errorf("rank[0]: got %q, want unhealthy", all.Pods[0].Rank)
	}
	if all.Pods[1].Rank != "healthy" {
		t.Errorf("rank[1]: got %q, want healthy", all.Pods[1].Rank)
	}
	// Field mapping.
	p := all.Pods[0]
	if p.Name != "crash" || p.Namespace != "b" || p.Restarts != 5 {
		t.Errorf("fields: %+v", p)
	}
	if p.OwnerKind != "ReplicaSet" || p.OwnerName != "crash-rs" {
		t.Errorf("owner: %+v", p)
	}
	if len(p.Containers) != 1 || p.Containers[0].State != "waiting:CrashLoopBackOff" {
		t.Errorf("containers: %+v", p.Containers)
	}

	// Namespaces populated (sorted distinct) only on all-ns.
	if len(all.Namespaces) != 2 || all.Namespaces[0] != "a" || all.Namespaces[1] != "b" {
		t.Errorf("namespaces all-load: %+v", all.Namespaces)
	}

	scoped := svc.ListPods("c", "b")
	if len(scoped.Namespaces) != 0 {
		t.Errorf("scoped: namespaces must be empty, got %+v", scoped.Namespaces)
	}
}

// --- GetPodDetail tests ---

func TestPodsService_GetPodDetail_ClusterMiss_NonNilEmpties(t *testing.T) {
	svc := NewPodsService(func(string) (PodsConn, bool) { return nil, false })
	d := svc.GetPodDetail("nope", "ns", "pod")
	if d.Labels == nil || d.Conditions == nil || d.Events == nil {
		t.Fatal("collections must be non-nil on cluster miss")
	}
}

func TestPodsService_GetPodDetail_Mapping(t *testing.T) {
	last := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	detail := fleet.PodDetail{
		Summary: workloads.PodSummary{
			Namespace: "ns", Name: "web", Ready: true,
			Phase: "Running", Rank: workloads.Healthy,
			Node: "n1", IP: "10.0.0.1", AgeSeconds: 30,
			Containers: []workloads.ContainerSummary{{Name: "web", Image: "nginx:1", Ready: true, State: "running"}},
		},
		Labels:         map[string]string{"env": "prod"},
		Conditions:     []crd.Condition{{Type: "Ready", Status: "True", Reason: "OK", Message: "ready"}},
		Events:         []crd.Event{{Type: "Normal", Reason: "Started", Message: "started", Count: 1, Last: last}},
		YAML:           "kind: Pod\n",
		QoSClass:       "Burstable",
		ServiceAccount: "web-sa",
	}
	conn := &fakePodConn{detail: detail}
	svc := NewPodsService(func(string) (PodsConn, bool) { return conn, true })

	d := svc.GetPodDetail("c", "ns", "web")
	if d.Summary.Name != "web" || d.Summary.Rank != "healthy" {
		t.Errorf("summary: %+v", d.Summary)
	}
	if d.Labels["env"] != "prod" {
		t.Errorf("labels: %+v", d.Labels)
	}
	if len(d.Conditions) != 1 || d.Conditions[0].Type != "Ready" {
		t.Errorf("conditions: %+v", d.Conditions)
	}
	if len(d.Events) != 1 || d.Events[0].Reason != "Started" || d.Events[0].LastSeen != "2026-06-09T12:00:00Z" {
		t.Errorf("events: %+v", d.Events)
	}
	if d.YAML != "kind: Pod\n" {
		t.Errorf("yaml: %q", d.YAML)
	}
	if d.QosClass != "Burstable" || d.ServiceAccount != "web-sa" {
		t.Errorf("qosClass/sa: %q %q", d.QosClass, d.ServiceAccount)
	}
}

func TestPodsService_GetPodDetail_ErrorReturnsEmpties(t *testing.T) {
	conn := &fakePodConn{detErr: context.DeadlineExceeded}
	svc := NewPodsService(func(string) (PodsConn, bool) { return conn, true })
	d := svc.GetPodDetail("c", "ns", "missing")
	if d.Labels == nil || d.Conditions == nil || d.Events == nil {
		t.Fatal("collections must be non-nil on error")
	}
	if d.Summary.Name != "" {
		t.Errorf("summary should be zero on error, got %+v", d.Summary)
	}
}
