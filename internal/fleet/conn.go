package fleet

import (
	"context"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/metadata/metadatainformer"
	"k8s.io/client-go/tools/cache"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
)

// Conn is the interface the registry drives. ClusterConn is the production impl.
type Conn interface {
	Name() string
	Start(ctx context.Context)
	Snapshot() Snapshot
}

var podGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}

const defaultResync = 5 * time.Minute
const defaultConnectTimeout = 30 * time.Second

type ClusterConn struct {
	name     string
	typed    kubernetes.Interface
	meta     metadata.Interface
	detector *capability.Detector
	clk      clock.Clock

	mu             sync.RWMutex
	state          ConnState
	reason         string
	lastSync       time.Time
	caps           capability.Set
	snapNodesReady int
	snapNodesTotal int
	snapPods       int
	connectTimeout time.Duration
	refresh        chan struct{} // buffered(1); coalesces informer events
}

func NewClusterConn(name string, typed kubernetes.Interface, meta metadata.Interface,
	detector *capability.Detector, clk clock.Clock) *ClusterConn {
	return &ClusterConn{
		name: name, typed: typed, meta: meta, detector: detector, clk: clk,
		state:          Unconnected,
		connectTimeout: defaultConnectTimeout,
		refresh:        make(chan struct{}, 1),
	}
}

func (c *ClusterConn) Name() string { return c.name }

func (c *ClusterConn) setState(ev Event, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if next, ok := Transition(c.state, ev); ok {
		c.state = next
	}
	if reason != "" {
		c.reason = reason
	}
}

// signalRefresh nudges the refresh loop without blocking. The buffered(1)
// channel coalesces bursts (e.g. the initial list of many pods) into one wake.
func (c *ClusterConn) signalRefresh() {
	select {
	case c.refresh <- struct{}{}:
	default:
	}
}

// onWatchError flips a synced connection to Stale when a list/watch fails.
// Pre-sync watch errors (state Connecting) are left to the connect-timeout
// path, so this is a no-op unless we are currently Synced or Degraded.
func (c *ClusterConn) onWatchError(err error) {
	c.mu.RLock()
	st := c.state
	c.mu.RUnlock()
	if st == Synced || st == Degraded {
		c.setState(EvWatchDrop, "watch error: "+err.Error())
	}
}

// Start launches the eager-set informers, wiring watch-error and event handlers
// before start, then runs the connect and refresh goroutines. All three loops
// are bound to ctx; the informers retry in the background, so a connection that
// fails to sync within connectTimeout is marked Failed but self-heals to Synced
// when a later relist succeeds.
func (c *ClusterConn) Start(ctx context.Context) {
	c.setState(EvStart, "")

	nodeFactory := informers.NewSharedInformerFactory(c.typed, defaultResync)
	nodeInformer := nodeFactory.Core().V1().Nodes().Informer()

	metaFactory := metadatainformer.NewSharedInformerFactory(c.meta, defaultResync)
	podInformer := metaFactory.ForResource(podGVR).Informer()

	// Register handlers BEFORE starting the informers. SetWatchErrorHandler
	// errors only if called after Start, which we do not do; ignore defensively.
	for _, inf := range []cache.SharedIndexInformer{nodeInformer, podInformer} {
		_ = inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
			c.onWatchError(err)
		})
		_, _ = inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(interface{}) { c.signalRefresh() },
			UpdateFunc: func(interface{}, interface{}) { c.signalRefresh() },
			DeleteFunc: func(interface{}) { c.signalRefresh() },
		})
	}

	nodeFactory.Start(ctx.Done())
	metaFactory.Start(ctx.Done())

	go c.refreshLoop(ctx, nodeInformer, podInformer)
	go c.connectLoop(ctx, nodeInformer, podInformer)
}

// connectLoop owns the initial connect. It bounds each sync attempt by
// connectTimeout; on success it runs detection and announces Synced (this is the
// only place the first EvSynced is emitted, so Detect always precedes it). On
// timeout it marks Failed and retries, so a never-synced cluster self-heals to
// Synced (Failed -> Synced) once connectivity returns.
func (c *ClusterConn) connectLoop(ctx context.Context, nodeInformer, podInformer cache.SharedIndexInformer) {
	for {
		tctx, cancel := context.WithTimeout(ctx, c.connectTimeout)
		ok := cache.WaitForCacheSync(tctx.Done(), nodeInformer.HasSynced, podInformer.HasSynced)
		cancel()

		if ctx.Err() != nil {
			return // parent cancelled
		}
		if ok {
			caps := c.detector.Detect(ctx)

			c.mu.Lock()
			c.caps = caps
			c.mu.Unlock()

			c.refreshCounts(nodeInformer, podInformer)
			c.setState(EvSynced, "")

			// Capability health is evaluated once at startup. Re-evaluation (and
			// the EvCapHealthy transition back to Synced) is deferred to a later
			// slice, including re-applying this overlay after a recovery.
			if caps.GitOps.Tier == capability.Degraded || caps.Network.Tier == capability.Degraded {
				c.setState(EvCapUnhealthy, capabilityReason(caps))
			}
			return
		}
		c.setState(EvConnError, "connect timed out after "+c.connectTimeout.String())
	}
}

// refreshLoop recomputes counts on coalesced informer events for the lifetime of
// ctx. It does not drive the initial Connecting -> Synced (connectLoop owns that,
// to avoid racing ahead of Detect). It does recover Stale -> Synced when a relist
// resumes after a dropped watch.
func (c *ClusterConn) refreshLoop(ctx context.Context, nodeInformer, podInformer cache.SharedIndexInformer) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.refresh:
			if !nodeInformer.HasSynced() || !podInformer.HasSynced() {
				continue
			}
			c.refreshCounts(nodeInformer, podInformer)

			c.mu.RLock()
			st := c.state
			c.mu.RUnlock()
			if st == Stale {
				c.setState(EvSynced, "")
			}
		}
	}
}

func capabilityReason(caps capability.Set) string {
	if caps.GitOps.Reason != "" {
		return caps.GitOps.Reason
	}
	return caps.Network.Reason
}

// refreshCounts recomputes node/pod counts and lastSync from the informer
// stores. Called by connectLoop on initial sync and by refreshLoop on every
// coalesced watch event.
func (c *ClusterConn) refreshCounts(nodeInformer, podInformer cache.SharedIndexInformer) {
	nodes := make([]*corev1.Node, 0)
	for _, obj := range nodeInformer.GetStore().List() {
		if n, ok := obj.(*corev1.Node); ok {
			nodes = append(nodes, n)
		}
	}
	ready, total := NodeReadiness(nodes)
	pods := len(podInformer.GetStore().List())

	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastSync = c.clk.Now()
	c.snapNodesReady, c.snapNodesTotal, c.snapPods = ready, total, pods
}

func (c *ClusterConn) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Snapshot{
		Name:         c.name,
		State:        c.state,
		Reason:       c.reason,
		LastSync:     c.lastSync,
		NodesReady:   c.snapNodesReady,
		NodesTotal:   c.snapNodesTotal,
		Pods:         c.snapPods,
		Capabilities: c.caps,
	}
}
