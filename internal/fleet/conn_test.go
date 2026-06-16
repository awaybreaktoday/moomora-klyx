package fleet

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	version "k8s.io/apimachinery/pkg/version"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func podMeta(name, ns string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}
}

func TestClusterConnSnapshotCountsAndSyncs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
	)

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme,
		podMeta("p1", "default"), podMeta("p2", "kube-system"))

	det := capability.NewDetector(typed)

	conn := NewClusterConn("plt-sea-prd-we-aks-01", typed, mclient, nil, det, clock.Real{}, config.MetricsConfig{})
	conn.Start(ctx)

	waitFor(t, 2*time.Second, func() bool {
		s := conn.Snapshot()
		return s.State == Synced || s.State == Degraded
	})

	s := conn.Snapshot()
	if s.Name != "plt-sea-prd-we-aks-01" {
		t.Fatalf("want name set, got %q", s.Name)
	}
	if s.NodesReady != 1 || s.NodesTotal != 1 {
		t.Fatalf("want 1/1 nodes, got %d/%d", s.NodesReady, s.NodesTotal)
	}
	if s.Pods != 2 {
		t.Fatalf("want 2 pods, got %d", s.Pods)
	}
	if s.LastSync.IsZero() {
		t.Fatal("want LastSync set after sync")
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", d)
}

func TestOnWatchErrorFromSyncedGoesStale(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	c.state = Synced // in-package: drive directly without a live sync
	c.onWatchError(errors.New("boom"))
	s := c.Snapshot()
	if s.State != Stale {
		t.Fatalf("want Stale, got %v", s.State)
	}
	if !strings.Contains(s.Reason, "watch error") {
		t.Fatalf("want reason to mention the watch error, got %q", s.Reason)
	}
}

func TestOnWatchErrorIgnoredWhenNotSynced(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	c.state = Connecting
	c.onWatchError(errors.New("boom"))
	if s := c.Snapshot(); s.State != Connecting {
		t.Fatalf("want Connecting unchanged, got %v", s.State)
	}
}

func TestOnWatchErrorRemembersPreSyncCredentialFailure(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	c.state = Connecting
	c.onWatchError(errors.New(`getting credentials: exec: "aws": executable file not found in $PATH`))
	s := c.Snapshot()
	if s.State != Connecting {
		t.Fatalf("want Connecting unchanged, got %v", s.State)
	}
	if !strings.Contains(s.Reason, "AWS CLI not found") {
		t.Fatalf("want friendly AWS reason, got %q", s.Reason)
	}
}

func TestNewClusterConnDefaultsConnectTimeout(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	if c.connectTimeout != defaultConnectTimeout {
		t.Fatalf("want default connect timeout %v, got %v", defaultConnectTimeout, c.connectTimeout)
	}
}

func TestConnectTimeoutGoesFailed(t *testing.T) {
	typed := fake.NewSimpleClientset()
	// Node list always errors, so the node informer never syncs.
	typed.PrependReactor("list", "nodes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("unreachable")
	})

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme)

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, nil, det, clock.Real{}, config.MetricsConfig{})
	c.connectTimeout = 100 * time.Millisecond // in-package override for a fast test

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)

	waitFor(t, 3*time.Second, func() bool { return c.Snapshot().State == Failed })
	if r := c.Snapshot().Reason; !strings.Contains(r, "connect timed out") {
		t.Fatalf("want a connect-timeout reason, got %q", r)
	}
}

func TestSetStateClearsReasonOnRecovery(t *testing.T) {
	c := NewClusterConn("x", nil, nil, nil, nil, clock.Real{}, config.MetricsConfig{})
	c.state = Stale
	c.reason = "watch error: boom"
	c.setState(EvSynced, "") // Stale -> Synced recovery
	s := c.Snapshot()
	if s.State != Synced {
		t.Fatalf("want Synced, got %v", s.State)
	}
	if s.Reason != "" {
		t.Fatalf("want reason cleared on recovery, got %q", s.Reason)
	}
}

func TestWatchDrivenRefreshUpdatesPodCount(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
	)
	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme,
		podMeta("p1", "default"), podMeta("p2", "default"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, nil, det, clock.Real{}, config.MetricsConfig{})
	c.Start(ctx)

	// Initial sync: 2 pods.
	waitFor(t, 2*time.Second, func() bool {
		s := c.Snapshot()
		return (s.State == Synced || s.State == Degraded) && s.Pods == 2
	})

	// A new pod appears -> Tracker().Create() fires a real watch ADD event ->
	// the metadata informer's AddFunc runs -> signalRefresh() -> count updates.
	p3 := podMeta("p3", "default")
	if err := mclient.Tracker().Create(podGVR, p3, "default"); err != nil {
		t.Fatalf("tracker create: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return c.Snapshot().Pods == 3 })
}

func TestClusterConnCapturesServerVersion(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	typed := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
	)
	typed.Discovery().(*discoveryfake.FakeDiscovery).FakedServerVersion = &version.Info{GitVersion: "v1.30.4"}

	mscheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(mscheme)
	mclient := metadatafake.NewSimpleMetadataClient(mscheme, podMeta("p1", "default"))

	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, mclient, nil, det, clock.Real{}, config.MetricsConfig{})
	c.Start(ctx)

	waitFor(t, 2*time.Second, func() bool {
		s := c.Snapshot()
		return (s.State == Synced || s.State == Degraded) && s.Version == "v1.30.4"
	})
}
