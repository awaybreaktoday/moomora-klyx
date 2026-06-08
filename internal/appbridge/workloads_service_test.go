package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/workloads"
)

type fakeWLConn struct {
	wl   []workloads.Workload
	flux bool
}

func (f fakeWLConn) ListWorkloads(context.Context, string) ([]workloads.Workload, bool, error) {
	return f.wl, f.flux, nil
}

func TestListWorkloadsDTO(t *testing.T) {
	t.Run("cluster miss -> empty non-nil", func(t *testing.T) {
		s := NewWorkloadsService(func(string) (WorkloadsConn, bool) { return nil, false })
		dto := s.ListWorkloads("nope", "")
		if dto.Workloads == nil || dto.Namespaces == nil {
			t.Fatal("slices must be non-nil")
		}
	})
	t.Run("maps + namespaces on all-load + rank string + flux", func(t *testing.T) {
		conn := fakeWLConn{flux: true, wl: []workloads.Workload{
			{Kind: "Deployment", Namespace: "b", Name: "x", Desired: 1, Ready: 0, Rank: workloads.Unhealthy, Reason: "CrashLoopBackOff",
				GitOps: &workloads.Owner{Kind: "Kustomization", Namespace: "flux-system", Name: "x"},
				Pods:   []workloads.Pod{{Name: "x-1", Ready: false, Restarts: 5, Reason: "CrashLoopBackOff", Node: "n1", AgeSeconds: 30}}},
			{Kind: "DaemonSet", Namespace: "a", Name: "y", Desired: 3, Ready: 3, Rank: workloads.Healthy},
		}}
		s := NewWorkloadsService(func(string) (WorkloadsConn, bool) { return conn, true })

		all := s.ListWorkloads("c", "")
		if !all.FluxPresent {
			t.Fatal("want FluxPresent true")
		}
		if len(all.Workloads) != 2 || all.Workloads[0].Rank != "unhealthy" {
			t.Fatalf("workloads: %+v", all.Workloads)
		}
		if all.Workloads[0].GitOps == nil || all.Workloads[0].GitOps.Name != "x" {
			t.Fatalf("owner: %+v", all.Workloads[0].GitOps)
		}
		if len(all.Workloads[0].Pods) != 1 || all.Workloads[0].Pods[0].AgeSeconds != 30 {
			t.Fatalf("pods: %+v", all.Workloads[0].Pods)
		}
		// Namespaces populated (sorted distinct) ONLY on all-load.
		if len(all.Namespaces) != 2 || all.Namespaces[0] != "a" || all.Namespaces[1] != "b" {
			t.Fatalf("namespaces: %+v", all.Namespaces)
		}
		scoped := s.ListWorkloads("c", "b")
		if len(scoped.Namespaces) != 0 {
			t.Fatalf("scoped namespaces should be empty, got %+v", scoped.Namespaces)
		}
	})
}
