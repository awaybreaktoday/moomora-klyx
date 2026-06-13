package fleet

import (
	"context"
	"fmt"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

const (
	// watchBackoffInitial / watchBackoffMax bound the per-kind reconnect backoff.
	// The first re-establish is fast (1s) so a transient drop barely registers;
	// repeated failures back off geometrically to a 30s ceiling. A successful
	// re-establish resets the backoff to the initial value.
	watchBackoffInitial = 1 * time.Second
	watchBackoffMax     = 30 * time.Second
)

// watchKinds maps the public kind names to a starter that opens a typed watch
// scoped to namespace ("" = all). Each starter returns a watch.Interface whose
// ResultChan delivers one event per change. Kept here (not a method) so the set
// of supported kinds is one self-contained table.
func (c *ClusterConn) watchStarter(kind string) (func(ctx context.Context, namespace string) (watch.Interface, error), error) {
	switch kind {
	case "pods":
		return func(ctx context.Context, ns string) (watch.Interface, error) {
			return c.typed.CoreV1().Pods(ns).Watch(ctx, metav1.ListOptions{})
		}, nil
	case "deployments":
		return func(ctx context.Context, ns string) (watch.Interface, error) {
			return c.typed.AppsV1().Deployments(ns).Watch(ctx, metav1.ListOptions{})
		}, nil
	case "statefulsets":
		return func(ctx context.Context, ns string) (watch.Interface, error) {
			return c.typed.AppsV1().StatefulSets(ns).Watch(ctx, metav1.ListOptions{})
		}, nil
	case "daemonsets":
		return func(ctx context.Context, ns string) (watch.Interface, error) {
			return c.typed.AppsV1().DaemonSets(ns).Watch(ctx, metav1.ListOptions{})
		}, nil
	case "events":
		return func(ctx context.Context, ns string) (watch.Interface, error) {
			return c.typed.CoreV1().Events(ns).Watch(ctx, metav1.ListOptions{})
		}, nil
	default:
		return nil, fmt.Errorf("unsupported watch kind %q", kind)
	}
}

// liveCounter aggregates per-kind liveness into a single onLive(bool) edge. It
// reports false the moment ANY kind's watch is down and true only once ALL
// kinds are up again. It debounces: onLive fires only on a transition, so a
// flapping kind among many up kinds does not spam the caller.
type liveCounter struct {
	mu     sync.Mutex
	total  int
	up     int
	states []bool
	last   bool // last reported aggregate (true = all up)
	onLive func(bool)
}

func newLiveCounter(total int, onLive func(bool)) *liveCounter {
	// Start optimistic-false: no kind is up yet, so the aggregate is false. The
	// first kind to establish does NOT flip us to true until all are up; the
	// caller's initial state is "not yet live".
	return &liveCounter{total: total, states: make([]bool, total), last: false, onLive: onLive}
}

func (l *liveCounter) set(idx int, up bool) {
	l.mu.Lock()
	if idx < 0 || idx >= l.total || l.states[idx] == up {
		l.mu.Unlock()
		return
	}
	l.states[idx] = up
	if up {
		l.up++
	} else {
		l.up--
	}
	agg := l.up == l.total
	changed := agg != l.last
	l.last = agg
	cb := l.onLive
	l.mu.Unlock()

	if changed && cb != nil {
		cb(agg)
	}
}

// WatchDirty starts watches on the given resource kinds scoped to namespace and
// invokes onDirty (non-blocking, coalesced by the caller) whenever any event
// arrives. It retries with backoff on watch failure and reports liveness
// transitions via onLive(bool). Returns a stop func. Kinds: "pods",
// "deployments", "statefulsets", "daemonsets", "events".
//
// Lifecycle / leak-safety: each kind gets exactly one supervisor goroutine that
// owns its watch.Interface. The goroutine loops {establish -> drain ResultChan
// -> on close/error mark down + backoff + retry} until the internal ctx (derived
// from the passed ctx) is cancelled, at which point it Stops its watcher and
// returns. stop() cancels that ctx once (sync.Once) and is safe to call
// repeatedly; ctx cancellation also flows from the parent ctx, so an app-wide
// shutdown drains every goroutine without a stop() call.
func (c *ClusterConn) WatchDirty(ctx context.Context, namespace string, kinds []string, onDirty func(), onLive func(bool)) (stop func(), err error) {
	// Validate all kinds up front so a bad kind fails the whole Open rather than
	// silently dropping one stream.
	starters := make([]func(context.Context, string) (watch.Interface, error), 0, len(kinds))
	for _, k := range kinds {
		s, err := c.watchStarter(k)
		if err != nil {
			return nil, err
		}
		starters = append(starters, s)
	}

	wctx, cancel := context.WithCancel(ctx)
	live := newLiveCounter(len(starters), onLive)

	var wg sync.WaitGroup
	for idx, start := range starters {
		wg.Add(1)
		go func(idx int, start func(context.Context, string) (watch.Interface, error)) {
			defer wg.Done()
			c.watchKindLoop(wctx, namespace, idx, start, onDirty, live)
		}(idx, start)
	}

	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			wg.Wait()
		})
	}
	return stop, nil
}

// watchKindLoop owns one kind's watch for the lifetime of ctx. It establishes
// the watch, drains its result channel forwarding every event to onDirty, and on
// channel close or establish error marks the kind down, backs off, and retries.
// A successful re-establish resets the backoff and marks the kind up.
func (c *ClusterConn) watchKindLoop(ctx context.Context, namespace string, idx int, start func(context.Context, string) (watch.Interface, error), onDirty func(), live *liveCounter) {
	backoff := watchBackoffInitial
	for {
		if ctx.Err() != nil {
			return
		}
		w, err := start(ctx, namespace)
		if err != nil {
			// Establish failed: this kind is down. Back off and retry unless
			// cancelled.
			live.set(idx, false)
			if !sleepCtx(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		// Established: this kind is up; reset backoff for the next failure.
		live.set(idx, true)
		backoff = watchBackoffInitial

		// Drain until the channel closes (server-side close, watch timeout, or
		// error event) or ctx is cancelled.
		ch := w.ResultChan()
		drainOpen := true
		for drainOpen {
			select {
			case <-ctx.Done():
				w.Stop()
				return
			case _, ok := <-ch:
				if !ok {
					drainOpen = false
					break
				}
				// Any event (Added/Modified/Deleted/Bookmark/Error) is a dirty
				// signal. The caller re-lists and recomputes; we do not inspect
				// the object here.
				onDirty()
			}
		}

		// Channel closed: stop the spent watcher, mark down, and loop to
		// re-establish after a short backoff.
		w.Stop()
		live.set(idx, false)
		if !sleepCtx(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

// sleepCtx sleeps for d or until ctx is cancelled. It returns false if ctx was
// cancelled (so the caller should return), true if the full duration elapsed.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > watchBackoffMax {
		return watchBackoffMax
	}
	return d
}
