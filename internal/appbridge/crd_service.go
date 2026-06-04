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
}

const crdTimeout = 30 * time.Second

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
