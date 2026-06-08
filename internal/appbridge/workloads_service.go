package appbridge

import (
	"context"
	"sort"
	"time"

	"github.com/moomora/klyx/internal/workloads"
)

const workloadsTimeout = 30 * time.Second

type WorkloadsConn interface {
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, bool, error)
}

type WorkloadsService struct {
	lookup func(string) (WorkloadsConn, bool)
}

func NewWorkloadsService(lookup func(string) (WorkloadsConn, bool)) *WorkloadsService {
	return &WorkloadsService{lookup: lookup}
}

// ListWorkloads returns the health-ranked workloads for a cluster, scoped to
// namespace ("" = all). Namespaces is the sorted distinct set of workload
// namespaces, populated ONLY on the all-namespaces load (dropdown source).
func (s *WorkloadsService) ListWorkloads(cluster, namespace string) WorkloadsResultDTO {
	out := WorkloadsResultDTO{Namespaces: []string{}, Workloads: []WorkloadDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), workloadsTimeout)
	defer cancel()
	wl, fluxPresent, err := conn.ListWorkloads(ctx, namespace)
	if err != nil {
		return out
	}
	out.FluxPresent = fluxPresent

	nsSet := map[string]bool{}
	for _, w := range wl {
		nsSet[w.Namespace] = true
		out.Workloads = append(out.Workloads, toWorkloadDTO(w))
	}
	if namespace == "" {
		for ns := range nsSet {
			out.Namespaces = append(out.Namespaces, ns)
		}
		sort.Strings(out.Namespaces)
	}
	return out
}

func toWorkloadDTO(w workloads.Workload) WorkloadDTO {
	d := WorkloadDTO{
		Kind: w.Kind, Namespace: w.Namespace, Name: w.Name,
		Desired: w.Desired, Ready: w.Ready, Available: w.Available, Updated: w.Updated,
		Restarts: w.Restarts, Reason: w.Reason, Rank: w.Rank.String(),
		Pods: make([]PodDTO, 0, len(w.Pods)),
	}
	if w.GitOps != nil {
		d.GitOps = &OwnerDTO{Kind: w.GitOps.Kind, Namespace: w.GitOps.Namespace, Name: w.GitOps.Name}
	}
	for _, p := range w.Pods {
		d.Pods = append(d.Pods, PodDTO{Name: p.Name, Ready: p.Ready, Restarts: p.Restarts, Reason: p.Reason, Node: p.Node, AgeSeconds: p.AgeSeconds})
	}
	return d
}
