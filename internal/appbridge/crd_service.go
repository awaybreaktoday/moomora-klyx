package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/crd"
)

// CRDConn is the per-cluster read surface CRDService needs.
type CRDConn interface {
	ListCRDs(ctx context.Context) ([]crd.Info, error)
	CountResource(ctx context.Context, group, version, plural string) (int, bool, error)
	ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error)
	GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error)
}

const crdTimeout = 30 * time.Second

const instancePageSize = 100

// CRDService is bound to JS. Pure request/response: ListCRDs returns the grouped
// tree (no counts); CountKind lazily counts one kind on group-expand.
type CRDService struct {
	lookup func(string) (CRDConn, bool)
}

func NewCRDService(lookup func(string) (CRDConn, bool)) *CRDService {
	return &CRDService{lookup: lookup}
}

// ListCRDs returns the cluster's CRDs grouped by API group with category and
// sorted deterministically. Empty on a cluster miss or a list error.
func (s *CRDService) ListCRDs(cluster string) []CRDGroupDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return []CRDGroupDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	infos, err := conn.ListCRDs(ctx)
	if err != nil {
		return []CRDGroupDTO{}
	}
	return groupCRDs(infos)
}

// CountKind returns the hybrid instance count for one kind. Zero value on miss.
func (s *CRDService) CountKind(cluster, group, version, plural string) CRDCountDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return CRDCountDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	count, capped, err := conn.CountResource(ctx, group, version, plural)
	if err != nil {
		return CRDCountDTO{}
	}
	return CRDCountDTO{Count: count, Capped: capped}
}

func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

// GetInstanceDetail returns the full per-instance detail. Zero value on miss/error.
func (s *CRDService) GetInstanceDetail(cluster, group, version, plural, namespace, name string) InstanceDetailDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return InstanceDetailDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	d, err := conn.GetInstanceDetail(ctx, group, version, plural, namespace, name)
	if err != nil {
		return InstanceDetailDTO{}
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
	return InstanceDetailDTO{
		Kind: d.Kind, Namespace: d.Namespace, Name: d.Name,
		Created: rfc3339(d.Created), Labels: labels,
		Conditions: conds, Events: events, YAML: d.YAML,
	}
}

// ListInstances returns one page of instances of a kind plus the next token.
// Empty page on a cluster miss or error.
func (s *CRDService) ListInstances(cluster, group, version, plural, continueToken string) InstancePageDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return InstancePageDTO{Items: []InstanceDTO{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	items, next, err := conn.ListInstances(ctx, group, version, plural, instancePageSize, continueToken)
	if err != nil {
		return InstancePageDTO{Items: []InstanceDTO{}}
	}
	dtos := make([]InstanceDTO, 0, len(items))
	for _, m := range items {
		created := ""
		if !m.Created.IsZero() {
			created = m.Created.Format(time.RFC3339)
		}
		dtos = append(dtos, InstanceDTO{Namespace: m.Namespace, Name: m.Name, Created: created})
	}
	return InstancePageDTO{Items: dtos, NextToken: next}
}
