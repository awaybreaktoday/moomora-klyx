package fleet

import (
	"time"

	"github.com/moomora/klyx/internal/capability"
)

// Snapshot is the per-cluster state the view layer consumes. It is a value copy;
// the registry never hands out live pointers into informer caches.
type Snapshot struct {
	Name         string
	State        ConnState
	Reason       string
	LastSync     time.Time
	NodesReady   int
	NodesTotal   int
	Pods         int
	Version      string
	Capabilities capability.Set
}
