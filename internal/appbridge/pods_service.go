package appbridge

import (
	"context"
	"sort"
	"time"

	"github.com/moomora/klyx/internal/fleet"
	"github.com/moomora/klyx/internal/workloads"
)

const podsTimeout = 30 * time.Second

// PodsConn is the per-cluster read surface PodsService needs. No fleet import
// in the interface itself — the lookup closure bridges to the real fleet.Conn.
type PodsConn interface {
	ListPods(ctx context.Context, namespace string) ([]workloads.PodSummary, error)
	PodDetail(ctx context.Context, namespace, name string) (fleet.PodDetail, error)
}

// PodsService is bound to JS. Pure request/response: ListPods returns
// classified pod rows; GetPodDetail returns the full drill-down.
type PodsService struct {
	lookup func(string) (PodsConn, bool)
}

// NewPodsService creates a PodsService with the given cluster-lookup function.
func NewPodsService(lookup func(string) (PodsConn, bool)) *PodsService {
	return &PodsService{lookup: lookup}
}

// ListPods returns health-ranked pod rows for a cluster, scoped to namespace
// ("" = all). Namespaces is the sorted distinct set, populated ONLY on the
// all-namespaces load (dropdown source). Cluster miss returns non-nil empties.
func (s *PodsService) ListPods(cluster, namespace string) PodsResultDTO {
	out := PodsResultDTO{Namespaces: []string{}, Pods: []PodSummaryDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), podsTimeout)
	defer cancel()
	pods, err := conn.ListPods(ctx, namespace)
	if err != nil {
		return out
	}

	nsSet := map[string]bool{}
	for _, p := range pods {
		nsSet[p.Namespace] = true
		out.Pods = append(out.Pods, toPodSummaryDTO(p))
	}
	if namespace == "" {
		for ns := range nsSet {
			out.Namespaces = append(out.Namespaces, ns)
		}
		sort.Strings(out.Namespaces)
	}
	return out
}

// GetPodDetail returns the full pod detail. Cluster miss or error returns a
// zero DTO with empty-but-non-nil collections (never panics on null).
func (s *PodsService) GetPodDetail(cluster, namespace, name string) PodDetailDTO {
	empty := PodDetailDTO{
		Labels:     map[string]string{},
		Conditions: []ConditionDTO{},
		Events:     []EventDTO{},
	}
	conn, ok := s.lookup(cluster)
	if !ok {
		return empty
	}
	ctx, cancel := context.WithTimeout(context.Background(), podsTimeout)
	defer cancel()
	d, err := conn.PodDetail(ctx, namespace, name)
	if err != nil {
		return empty
	}

	labels := d.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	conds := make([]ConditionDTO, 0, len(d.Conditions))
	for _, c := range d.Conditions {
		conds = append(conds, ConditionDTO{Type: c.Type, Status: c.Status, Reason: c.Reason, Message: c.Message})
	}
	events := make([]EventDTO, 0, len(d.Events))
	for _, e := range d.Events {
		events = append(events, EventDTO{Type: e.Type, Reason: e.Reason, Message: e.Message, Count: int(e.Count), LastSeen: rfc3339(e.Last)})
	}
	return PodDetailDTO{
		Summary:        toPodSummaryDTO(d.Summary),
		Labels:         labels,
		Conditions:     conds,
		Events:         events,
		YAML:           d.YAML,
		QosClass:       d.QoSClass,
		ServiceAccount: d.ServiceAccount,
	}
}

func toPodSummaryDTO(p workloads.PodSummary) PodSummaryDTO {
	containers := make([]ContainerSummaryDTO, 0, len(p.Containers))
	for _, c := range p.Containers {
		containers = append(containers, ContainerSummaryDTO{
			Name:     c.Name,
			Image:    c.Image,
			Ready:    c.Ready,
			Restarts: c.Restarts,
			State:    c.State,
			Init:     c.Init,
		})
	}
	return PodSummaryDTO{
		Namespace:  p.Namespace,
		Name:       p.Name,
		Ready:      p.Ready,
		Phase:      p.Phase,
		Reason:     p.Reason,
		Rank:       p.Rank.String(),
		Restarts:   p.Restarts,
		Node:       p.Node,
		IP:         p.IP,
		OwnerKind:  p.OwnerKind,
		OwnerName:  p.OwnerName,
		AgeSeconds: p.AgeSeconds,
		Containers: containers,
	}
}
