package appbridge

import (
	"context"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// GitOpsConn is the per-cluster watch surface GitOpsService needs.
type GitOpsConn interface {
	OpenGitOps()
	CloseGitOps()
	GitOpsResources() []flux.Resource
	GitOpsObject(kind, namespace, name string) (*unstructured.Unstructured, bool)
}

// GitOpsUpdatedEvent is emitted with { cluster, resources }.
const GitOpsUpdatedEvent = "gitops:updated"

type gitOpsPayload struct {
	Cluster   string            `json:"cluster"`
	Resources []FluxResourceDTO `json:"resources"`
}

// GitOpsService is bound to JS. Open starts a cluster's lazy watch and pushes
// gitops:updated on a tick; Close stops it.
type GitOpsService struct {
	lookup   func(string) (GitOpsConn, bool)
	em       Emitter
	now      func() time.Time
	interval time.Duration

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewGitOpsService(lookup func(string) (GitOpsConn, bool), em Emitter, now func() time.Time, interval time.Duration) *GitOpsService {
	return &GitOpsService{lookup: lookup, em: em, now: now, interval: interval, cancels: map[string]context.CancelFunc{}}
}

func (s *GitOpsService) Open(cluster string) {
	conn, ok := s.lookup(cluster)
	if !ok {
		return
	}
	s.mu.Lock()
	if _, active := s.cancels[cluster]; active {
		s.mu.Unlock()
		return // idempotent
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancels[cluster] = cancel
	s.mu.Unlock()

	conn.OpenGitOps()
	go s.pushLoop(ctx, cluster, conn)
}

func (s *GitOpsService) Close(cluster string) {
	s.mu.Lock()
	cancel := s.cancels[cluster]
	delete(s.cancels, cluster)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if conn, ok := s.lookup(cluster); ok {
		conn.CloseGitOps()
	}
}

func (s *GitOpsService) pushLoop(ctx context.Context, cluster string, conn GitOpsConn) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := s.now()
			res := conn.GitOpsResources()
			dtos := make([]FluxResourceDTO, 0, len(res))
			for _, r := range res {
				dtos = append(dtos, ToFluxDTO(r, now))
			}
			s.em.Emit(GitOpsUpdatedEvent, gitOpsPayload{Cluster: cluster, Resources: dtos})
		}
	}
}

// GetResourceDetail returns the detail view for one Flux resource from the live
// watch store. Zero-value DTO when the cluster/object isn't available.
func (s *GitOpsService) GetResourceDetail(cluster, kind, namespace, name string) ResourceDetailDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ResourceDetailDTO{}
	}
	u, ok := conn.GitOpsObject(kind, namespace, name)
	if !ok {
		return ResourceDetailDTO{}
	}
	return toDetailDTO(flux.ParseDetail(u))
}
