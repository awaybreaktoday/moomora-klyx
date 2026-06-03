package fleet

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/moomora/klyx/internal/config"
)

// ConnFactory builds a Conn for a cluster. Injected so tests use fakes.
type ConnFactory func(config.ClusterConfig) (Conn, error)

type entry struct {
	conn     Conn
	failed   bool
	failName string
	failMsg  string
}

type Registry struct {
	cfg     *config.Config
	factory ConnFactory

	mu      sync.RWMutex
	entries []entry
}

func NewRegistry(cfg *config.Config, factory ConnFactory) *Registry {
	return &Registry{cfg: cfg, factory: factory}
}

// Start constructs and starts every configured conn. A conn that fails to
// construct is recorded as Failed and does not stop the others.
func (r *Registry) Start(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.entries) > 0 {
		return // already started
	}
	for _, cc := range r.cfg.Clusters {
		conn, err := r.factory(cc)
		if err != nil {
			r.entries = append(r.entries, entry{
				failed: true, failName: cc.Name,
				failMsg: fmt.Sprintf("failed to connect: %v", err),
			})
			continue
		}
		conn.Start(ctx)
		r.entries = append(r.entries, entry{conn: conn})
	}
}

// Snapshots returns one snapshot per configured cluster, sorted by name.
func (r *Registry) Snapshots() []Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Snapshot, 0, len(r.entries))
	for _, e := range r.entries {
		if e.failed {
			out = append(out, Snapshot{Name: e.failName, State: Failed, Reason: e.failMsg})
			continue
		}
		out = append(out, e.conn.Snapshot())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
