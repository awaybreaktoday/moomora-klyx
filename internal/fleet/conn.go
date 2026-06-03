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

const eagerResync = 5 * time.Minute

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
}

func NewClusterConn(name string, typed kubernetes.Interface, meta metadata.Interface,
	detector *capability.Detector, clk clock.Clock) *ClusterConn {
	return &ClusterConn{
		name: name, typed: typed, meta: meta, detector: detector, clk: clk,
		state: Unconnected,
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

// Start launches the eager-set informers and detection in the background.
func (c *ClusterConn) Start(ctx context.Context) {
	c.setState(EvStart, "")

	nodeFactory := informers.NewSharedInformerFactory(c.typed, eagerResync)
	nodeInformer := nodeFactory.Core().V1().Nodes().Informer()

	metaFactory := metadatainformer.NewSharedInformerFactory(c.meta, eagerResync)
	podInformer := metaFactory.ForResource(podGVR).Informer()

	go nodeFactory.Start(ctx.Done())
	go metaFactory.Start(ctx.Done())

	go func() {
		okNodes := cache.WaitForCacheSync(ctx.Done(), nodeInformer.HasSynced)
		okPods := cache.WaitForCacheSync(ctx.Done(), podInformer.HasSynced)
		if !okNodes || !okPods {
			c.setState(EvConnError, "informer cache failed to sync")
			return
		}

		caps := c.detector.Detect(ctx)
		c.mu.Lock()
		c.caps = caps
		c.lastSync = c.clk.Now()
		c.mu.Unlock()
		c.setState(EvSynced, "")

		if caps.GitOps.Tier == capability.Degraded || caps.Network.Tier == capability.Degraded {
			c.setState(EvCapUnhealthy, capabilityReason(caps))
		}

		c.refreshCounts(nodeInformer, podInformer)
	}()
}

func capabilityReason(caps capability.Set) string {
	if caps.GitOps.Reason != "" {
		return caps.GitOps.Reason
	}
	return caps.Network.Reason
}

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
