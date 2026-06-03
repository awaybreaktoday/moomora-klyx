# Klyx Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go data-layer spine for Klyx M1 - load a Klyx-owned fleet config, connect to N clusters via client-go, track each connection's health in a state machine, expose live node/pod counts and tiered capability detection, and aggregate it across the fleet - all headless and fully testable before any UI exists.

**Architecture:** A `ClusterRegistry` owns one `ClusterConn` per configured cluster. Each conn runs in its own goroutine under its own context, owns one informer factory (typed informer for nodes, metadata-only informer for pods), and reports a `Snapshot` with a `ConnState`. Failures are isolated per conn and surfaced as state, never cascaded. A capability detector classifies Flux/Argo/Cilium/Gateway API as Absent/Degraded/Healthy. All time goes through an injected clock.

**Tech Stack:** Go 1.22+, `k8s.io/client-go` (clientcmd, kubernetes, metadata, discovery, informers), `gopkg.in/yaml.v3`, standard `testing`. Fakes: `client-go/kubernetes/fake`, `client-go/metadata/fake`, `client-go/discovery/fake`.

**Module path:** `github.com/moomora/klyx` (adjust the first task if the canonical module path differs).

**Out of scope (later slices):** Wails/React UI, metrics/PromQL client, GitOps drift models, network topology, CRD browser, mutating actions.

---

### Task 1: Module scaffolding and test command

**Files:**
- Create: `go.mod`
- Create: `internal/.gitkeep`
- Create: `Makefile`

- [ ] **Step 1: Initialise the module**

Run:
```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
go mod init github.com/moomora/klyx
go get k8s.io/client-go@v0.30.4 k8s.io/apimachinery@v0.30.4 k8s.io/api@v0.30.4 gopkg.in/yaml.v3@v3.0.1
```
Expected: `go.mod` and `go.sum` created with those requires.

- [ ] **Step 2: Add a Makefile**

```makefile
.PHONY: test vet
test:
	go test ./...
vet:
	go vet ./...
```

- [ ] **Step 3: Verify the toolchain builds**

Run: `go build ./... && go vet ./...`
Expected: no output, exit 0 (nothing to build yet is fine).

- [ ] **Step 4: Commit**

```bash
git add go.mod go.sum Makefile internal/.gitkeep
git commit -m "chore: initialise klyx go module and test command"
```

---

### Task 2: Injected clock

A single clock abstraction so staleness logic is deterministic in tests.

**Files:**
- Create: `internal/clock/clock.go`
- Test: `internal/clock/clock_test.go`

- [ ] **Step 1: Write the failing test**

```go
package clock

import (
	"testing"
	"time"
)

func TestFakeClockAdvances(t *testing.T) {
	start := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	c := NewFake(start)
	if !c.Now().Equal(start) {
		t.Fatalf("want %v, got %v", start, c.Now())
	}
	c.Advance(90 * time.Second)
	if got := c.Now(); !got.Equal(start.Add(90 * time.Second)) {
		t.Fatalf("want +90s, got %v", got)
	}
}

func TestRealClockMovesForward(t *testing.T) {
	c := Real{}
	a := c.Now()
	b := c.Now()
	if b.Before(a) {
		t.Fatalf("real clock went backwards: %v then %v", a, b)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/clock/ -run TestFakeClockAdvances -v`
Expected: FAIL - `undefined: NewFake`.

- [ ] **Step 3: Write minimal implementation**

```go
// Package clock provides an injectable time source for deterministic tests.
package clock

import (
	"sync"
	"time"
)

// Clock is the minimal time source the data layer depends on.
type Clock interface {
	Now() time.Time
}

// Real is the production clock.
type Real struct{}

func (Real) Now() time.Time { return time.Now() }

// Fake is a controllable clock for tests.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

func NewFake(t time.Time) *Fake { return &Fake{now: t} }

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/clock/ -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add internal/clock/
git commit -m "feat: add injectable clock"
```

---

### Task 3: Fleet config types, loading, and validation

**Files:**
- Create: `internal/config/config.go`
- Test: `internal/config/config_test.go`
- Test fixture: `internal/config/testdata/fleet.yaml`

- [ ] **Step 1: Write the test fixture**

`internal/config/testdata/fleet.yaml`:
```yaml
clusters:
  - name: plt-sea-prd-we-aks-01
    context: prd-we
    tags:
      env: prd
      region: we
      provider: aks
    group: prd-we
    metrics:
      endpoint: https://mimir.prd-we.example/prometheus
      token: tok-123
  - name: vimadaboda-k3s
    tags:
      env: homelab
      provider: k3s
```

- [ ] **Step 2: Write the failing test**

```go
package config

import (
	"path/filepath"
	"testing"
)

func TestLoadValidConfig(t *testing.T) {
	c, err := Load(filepath.Join("testdata", "fleet.yaml"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(c.Clusters) != 2 {
		t.Fatalf("want 2 clusters, got %d", len(c.Clusters))
	}
	first := c.Clusters[0]
	if first.Context != "prd-we" {
		t.Fatalf("want context prd-we, got %q", first.Context)
	}
	if first.Tags["env"] != "prd" {
		t.Fatalf("want env prd, got %q", first.Tags["env"])
	}
	if first.Metrics == nil || first.Metrics.Endpoint == "" {
		t.Fatalf("want metrics endpoint set")
	}
	// Context defaults to Name when omitted.
	if c.Clusters[1].Context != "vimadaboda-k3s" {
		t.Fatalf("want defaulted context, got %q", c.Clusters[1].Context)
	}
}

func TestValidateRejectsDuplicateNames(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{{Name: "a"}, {Name: "a"}}}
	if err := c.validate(); err == nil {
		t.Fatal("expected duplicate-name error")
	}
}

func TestValidateRejectsEmptyName(t *testing.T) {
	c := &Config{Clusters: []ClusterConfig{{Name: ""}}}
	if err := c.validate(); err == nil {
		t.Fatal("expected empty-name error")
	}
}

func TestValidateRejectsNoClusters(t *testing.T) {
	c := &Config{}
	if err := c.validate(); err == nil {
		t.Fatal("expected no-clusters error")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/config/ -v`
Expected: FAIL - `undefined: Load`.

- [ ] **Step 4: Write minimal implementation**

```go
// Package config loads the Klyx-owned fleet configuration. Cluster identity,
// grouping, environment tags, and metrics endpoints are declared here;
// kubeconfig is used only to resolve credentials.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Clusters []ClusterConfig `yaml:"clusters"`
}

type ClusterConfig struct {
	Name       string            `yaml:"name"`
	Context    string            `yaml:"context"`
	Kubeconfig string            `yaml:"kubeconfig"`
	Tags       map[string]string `yaml:"tags"`
	Group      string            `yaml:"group"`
	Metrics    *MetricsConfig    `yaml:"metrics"`
}

type MetricsConfig struct {
	Endpoint      string `yaml:"endpoint"`
	Token         string `yaml:"token"`
	TLSSkipVerify bool   `yaml:"tlsSkipVerify"`
}

// Env returns the environment tag, or "" if unset.
func (c ClusterConfig) Env() string { return c.Tags["env"] }

// Load reads, parses, defaults, and validates a fleet config file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %q: %w", path, err)
	}
	var c Config
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse config %q: %w", path, err)
	}
	c.applyDefaults()
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("invalid config %q: %w", path, err)
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	for i := range c.Clusters {
		if c.Clusters[i].Context == "" {
			c.Clusters[i].Context = c.Clusters[i].Name
		}
	}
}

func (c *Config) validate() error {
	if len(c.Clusters) == 0 {
		return fmt.Errorf("no clusters configured")
	}
	seen := make(map[string]bool, len(c.Clusters))
	for i, cl := range c.Clusters {
		if cl.Name == "" {
			return fmt.Errorf("cluster[%d]: name is required", i)
		}
		if seen[cl.Name] {
			return fmt.Errorf("duplicate cluster name %q", cl.Name)
		}
		seen[cl.Name] = true
	}
	return nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/config/ -v`
Expected: PASS (all four tests).

- [ ] **Step 6: Commit**

```bash
git add internal/config/
git commit -m "feat: load and validate klyx fleet config"
```

---

### Task 4: Cluster REST config resolver

Resolve a `*rest.Config` from a `ClusterConfig`. client-go runs exec credential plugins (kubelogin, aws eks get-token) automatically, so this is mostly clientcmd wiring.

**Files:**
- Create: `internal/cluster/restconfig.go`
- Test: `internal/cluster/restconfig_test.go`
- Test fixture: `internal/cluster/testdata/kubeconfig.yaml`

- [ ] **Step 1: Write the kubeconfig fixture**

`internal/cluster/testdata/kubeconfig.yaml`:
```yaml
apiVersion: v1
kind: Config
clusters:
  - name: c-prd-we
    cluster:
      server: https://prd-we.example:6443
      insecure-skip-tls-verify: true
contexts:
  - name: prd-we
    context:
      cluster: c-prd-we
      user: u-prd-we
current-context: prd-we
users:
  - name: u-prd-we
    user:
      token: fixture-token
```

- [ ] **Step 2: Write the failing test**

```go
package cluster

import (
	"path/filepath"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

func TestRESTConfigResolvesContext(t *testing.T) {
	cc := config.ClusterConfig{
		Name:       "plt-sea-prd-we-aks-01",
		Context:    "prd-we",
		Kubeconfig: filepath.Join("testdata", "kubeconfig.yaml"),
	}
	rc, err := RESTConfig(cc)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rc.Host != "https://prd-we.example:6443" {
		t.Fatalf("want resolved host, got %q", rc.Host)
	}
}

func TestRESTConfigErrorsOnMissingContext(t *testing.T) {
	cc := config.ClusterConfig{
		Name:       "x",
		Context:    "does-not-exist",
		Kubeconfig: filepath.Join("testdata", "kubeconfig.yaml"),
	}
	if _, err := RESTConfig(cc); err == nil {
		t.Fatal("expected error for unknown context")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/cluster/ -v`
Expected: FAIL - `undefined: RESTConfig`.

- [ ] **Step 4: Write minimal implementation**

```go
// Package cluster resolves per-cluster credentials from kubeconfig. Exec
// credential plugins (kubelogin, aws eks get-token) are invoked automatically
// by client-go when the resolved context uses them.
package cluster

import (
	"fmt"
	"os"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/moomora/klyx/internal/config"
)

// RESTConfig builds a *rest.Config for the cluster's kubeconfig context.
func RESTConfig(cc config.ClusterConfig) (*rest.Config, error) {
	kubeconfigPath := cc.Kubeconfig
	if kubeconfigPath == "" {
		kubeconfigPath = os.Getenv("KUBECONFIG")
	}
	if kubeconfigPath == "" {
		if home, err := os.UserHomeDir(); err == nil {
			kubeconfigPath = home + "/.kube/config"
		}
	}
	loadingRules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath}
	overrides := &clientcmd.ConfigOverrides{CurrentContext: cc.Context}
	cc2 := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides)
	rc, err := cc2.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("resolve rest config for context %q: %w", cc.Context, err)
	}
	return rc, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/cluster/ -v`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add internal/cluster/
git commit -m "feat: resolve per-cluster rest config from kubeconfig"
```

---

### Task 5: Connection state machine

Pure transition logic for the per-cluster FSM. No I/O.

**Files:**
- Create: `internal/fleet/state.go`
- Test: `internal/fleet/state_test.go`

- [ ] **Step 1: Write the failing test**

```go
package fleet

import "testing"

func TestTransitions(t *testing.T) {
	cases := []struct {
		from ConnState
		ev   Event
		want ConnState
		ok   bool
	}{
		{Unconnected, EvStart, Connecting, true},
		{Connecting, EvSynced, Synced, true},
		{Connecting, EvConnError, Failed, true},
		{Synced, EvCapUnhealthy, Degraded, true},
		{Degraded, EvCapHealthy, Synced, true},
		{Synced, EvWatchDrop, Stale, true},
		{Degraded, EvWatchDrop, Stale, true},
		{Stale, EvSynced, Synced, true},
		{Failed, EvStart, Connecting, true},
		{Synced, EvConnError, Failed, true},
		// illegal transition: cannot go Unconnected -> Synced directly
		{Unconnected, EvSynced, Unconnected, false},
	}
	for _, tc := range cases {
		got, ok := Transition(tc.from, tc.ev)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Transition(%v,%v) = (%v,%v), want (%v,%v)",
				tc.from, tc.ev, got, ok, tc.want, tc.ok)
		}
	}
}

func TestStateStringStable(t *testing.T) {
	if Synced.String() != "Synced" {
		t.Fatalf("want Synced, got %q", Synced.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestTransitions -v`
Expected: FAIL - `undefined: ConnState`.

- [ ] **Step 3: Write minimal implementation**

```go
package fleet

// ConnState is the lifecycle state of a single cluster connection.
type ConnState int

const (
	Unconnected ConnState = iota
	Connecting
	Synced
	Degraded // connected and syncing, but a capability/metrics subsystem is unhealthy
	Stale    // watches dropped, last cache retained
	Failed   // connection or auth failed
)

func (s ConnState) String() string {
	switch s {
	case Unconnected:
		return "Unconnected"
	case Connecting:
		return "Connecting"
	case Synced:
		return "Synced"
	case Degraded:
		return "Degraded"
	case Stale:
		return "Stale"
	case Failed:
		return "Failed"
	default:
		return "Unknown"
	}
}

// Event drives a state transition.
type Event int

const (
	EvStart Event = iota
	EvSynced
	EvConnError
	EvWatchDrop
	EvCapUnhealthy
	EvCapHealthy
)

// Transition returns the next state and whether the transition is legal.
// Illegal transitions return the original state and false.
func Transition(from ConnState, ev Event) (ConnState, bool) {
	// A connection error is terminal-to-Failed from any connected state.
	if ev == EvConnError {
		return Failed, true
	}
	switch from {
	case Unconnected, Failed:
		if ev == EvStart {
			return Connecting, true
		}
	case Connecting:
		if ev == EvSynced {
			return Synced, true
		}
	case Synced:
		switch ev {
		case EvCapUnhealthy:
			return Degraded, true
		case EvWatchDrop:
			return Stale, true
		}
	case Degraded:
		switch ev {
		case EvCapHealthy:
			return Synced, true
		case EvWatchDrop:
			return Stale, true
		}
	case Stale:
		if ev == EvSynced {
			return Synced, true
		}
	}
	return from, false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/state.go internal/fleet/state_test.go
git commit -m "feat: per-cluster connection state machine"
```

---

### Task 6: Capability model and tiered classification

Pure types and classification logic. No I/O.

**Files:**
- Create: `internal/capability/capability.go`
- Test: `internal/capability/capability_test.go`

- [ ] **Step 1: Write the failing test**

```go
package capability

import "testing"

func TestClassifyTier(t *testing.T) {
	cases := []struct {
		present bool
		healthy bool
		want    Tier
	}{
		{present: false, healthy: false, want: Absent},
		{present: true, healthy: false, want: Degraded},
		{present: true, healthy: true, want: Healthy},
	}
	for _, tc := range cases {
		if got := Classify(tc.present, tc.healthy); got != tc.want {
			t.Errorf("Classify(%v,%v)=%v want %v", tc.present, tc.healthy, got, tc.want)
		}
	}
}

func TestSetReports(t *testing.T) {
	s := Set{
		GitOps: GitOpsCapability{
			Base: Base{Tier: Degraded, Reason: "kustomize-controller not ready"},
			Flux: FluxInfo{Present: true, Version: "v2.4.0", Healthy: false},
		},
	}
	if s.GitOps.Tier != Degraded {
		t.Fatalf("want Degraded, got %v", s.GitOps.Tier)
	}
	if s.GitOps.Reason == "" {
		t.Fatal("degraded capability must carry a reason")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capability/ -v`
Expected: FAIL - `undefined: Classify`.

- [ ] **Step 3: Write minimal implementation**

```go
// Package capability models tiered capability detection. Presence-only is
// insufficient: a tool can be installed but not working, so state is tiered.
package capability

// Tier is the three-state classification for any capability.
type Tier int

const (
	Absent   Tier = iota // CRDs/APIs not served - view hidden
	Degraded             // installed but not fully working/partial - view renders with banner
	Healthy              // installed and operational
)

func (t Tier) String() string {
	switch t {
	case Absent:
		return "Absent"
	case Degraded:
		return "Degraded"
	case Healthy:
		return "Healthy"
	default:
		return "Unknown"
	}
}

// Classify maps (present, healthy) to a Tier.
func Classify(present, healthy bool) Tier {
	switch {
	case !present:
		return Absent
	case !healthy:
		return Degraded
	default:
		return Healthy
	}
}

// Base is embedded by every capability; it carries the tier and a human reason.
type Base struct {
	Tier   Tier
	Reason string
}

type FluxInfo struct {
	Present     bool
	Version     string
	Controllers []string
	Healthy     bool
}

type ArgoInfo struct {
	Present bool
	Version string
	Healthy bool
}

// GitOpsCapability models both tools together because the GitOps view needs them
// in one place, including their coexistence.
type GitOpsCapability struct {
	Base
	Flux        FluxInfo
	Argo        ArgoInfo
	Coexistence bool
}

// NetworkCapability is finer-grained: Gateway API present without EnvoyProxy is
// Degraded, not Absent.
type NetworkCapability struct {
	Base
	GatewayAPIVersion  string
	HasEnvoyProxy      bool
	CiliumPresent      bool
	HasHubble          bool
	ClusterMesh        bool
	IngressControllers []string
}

// Set is the full per-cluster capability snapshot handed to the view layer.
type Set struct {
	GitOps  GitOpsCapability
	Network NetworkCapability
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/capability/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/capability/capability.go internal/capability/capability_test.go
git commit -m "feat: tiered capability model"
```

---

### Task 7: Capability detector (discovery presence + controller health)

Detects presence via the discovery API and health via controller Deployment readiness, using fake clients in tests.

**Files:**
- Create: `internal/capability/detector.go`
- Test: `internal/capability/detector_test.go`

- [ ] **Step 1: Write the failing test**

```go
package capability

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	discoveryfake "k8s.io/client-go/discovery/fake"
)

func newFake(groups []*metav1.APIResourceList, objs ...runtime.Object) *fake.Clientset {
	cs := fake.NewSimpleClientset(objs...)
	cs.Discovery().(*discoveryfake.FakeDiscovery).Resources = groups
	return cs
}

func fluxControllerDeploy(name string, ready int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "flux-system"},
		Status:     appsv1.DeploymentStatus{AvailableReplicas: ready},
		Spec:       appsv1.DeploymentSpec{Replicas: ptr(int32(1))},
	}
}

func ptr[T any](v T) *T { return &v }

func TestDetectFluxAbsent(t *testing.T) {
	cs := newFake(nil)
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Absent {
		t.Fatalf("want Absent, got %v", set.GitOps.Tier)
	}
}

func TestDetectFluxPresentButUnhealthy(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "kustomize.toolkit.fluxcd.io/v1"}}
	cs := newFake(groups, fluxControllerDeploy("kustomize-controller", 0))
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Degraded {
		t.Fatalf("want Degraded, got %v (%s)", set.GitOps.Tier, set.GitOps.Reason)
	}
	if set.GitOps.Reason == "" {
		t.Fatal("expected a reason for degraded flux")
	}
}

func TestDetectFluxHealthy(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "kustomize.toolkit.fluxcd.io/v1"}}
	cs := newFake(groups, fluxControllerDeploy("kustomize-controller", 1))
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.GitOps.Tier != Healthy {
		t.Fatalf("want Healthy, got %v", set.GitOps.Tier)
	}
	if !set.GitOps.Flux.Present || !set.GitOps.Flux.Healthy {
		t.Fatalf("want flux present+healthy, got %+v", set.GitOps.Flux)
	}
}

func TestDetectGatewayPresentWithoutEnvoyProxyIsDegraded(t *testing.T) {
	groups := []*metav1.APIResourceList{{GroupVersion: "gateway.networking.k8s.io/v1"}}
	cs := newFake(groups)
	d := NewDetector(cs)
	set := d.Detect(context.Background())
	if set.Network.Tier != Degraded {
		t.Fatalf("want Degraded (no EnvoyProxy), got %v", set.Network.Tier)
	}
	if set.Network.GatewayAPIVersion != "v1" {
		t.Fatalf("want pinned version v1, got %q", set.Network.GatewayAPIVersion)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/capability/ -run TestDetect -v`
Expected: FAIL - `undefined: NewDetector`.

- [ ] **Step 3: Write minimal implementation**

```go
package capability

import (
	"context"
	"fmt"
	"strings"

	"k8s.io/client-go/kubernetes"
)

// Detector classifies capabilities for one cluster.
type Detector struct {
	cs kubernetes.Interface
}

func NewDetector(cs kubernetes.Interface) *Detector { return &Detector{cs: cs} }

// servedGroups returns the set of served "group/version" strings, and a map of
// bare group -> served version (last one wins; callers pin explicitly below).
func (d *Detector) servedGroups(ctx context.Context) (map[string]bool, error) {
	lists, err := d.cs.Discovery().ServerGroups()
	_ = ctx
	if err != nil {
		return nil, err
	}
	served := make(map[string]bool)
	for _, g := range lists.Groups {
		for _, v := range g.Versions {
			served[v.GroupVersion] = true // e.g. "gateway.networking.k8s.io/v1"
			served[g.Name] = true          // bare group presence
		}
	}
	return served, nil
}

func (d *Detector) Detect(ctx context.Context) Set {
	served, err := d.servedGroups(ctx)
	if err != nil {
		served = map[string]bool{}
	}
	return Set{
		GitOps:  d.detectGitOps(ctx, served),
		Network: d.detectNetwork(ctx, served),
	}
}

func (d *Detector) detectGitOps(ctx context.Context, served map[string]bool) GitOpsCapability {
	fluxPresent := served["kustomize.toolkit.fluxcd.io"]
	argoPresent := served["argoproj.io"]

	cap := GitOpsCapability{}
	cap.Flux.Present = fluxPresent
	cap.Argo.Present = argoPresent
	cap.Coexistence = fluxPresent && argoPresent

	if !fluxPresent && !argoPresent {
		cap.Base = Base{Tier: Absent, Reason: "no Flux or Argo CRDs installed"}
		return cap
	}

	var reasons []string
	if fluxPresent {
		healthy, reason := d.controllerHealthy(ctx, "flux-system", "kustomize-controller")
		cap.Flux.Healthy = healthy
		cap.Flux.Controllers = []string{"kustomize-controller"}
		if !healthy {
			reasons = append(reasons, "Flux installed but "+reason)
		}
	}
	if argoPresent {
		healthy, reason := d.controllerHealthy(ctx, "argocd", "argocd-application-controller")
		cap.Argo.Healthy = healthy
		if !healthy {
			reasons = append(reasons, "Argo installed but "+reason)
		}
	}

	fluxOK := !fluxPresent || cap.Flux.Healthy
	argoOK := !argoPresent || cap.Argo.Healthy
	cap.Base.Tier = Classify(true, fluxOK && argoOK)
	cap.Base.Reason = strings.Join(reasons, "; ")
	return cap
}

func (d *Detector) detectNetwork(ctx context.Context, served map[string]bool) NetworkCapability {
	cap := NetworkCapability{}
	cap.CiliumPresent = served["cilium.io"]

	gwVersion := ""
	switch {
	case served["gateway.networking.k8s.io/v1"]:
		gwVersion = "v1"
	case served["gateway.networking.k8s.io/v1beta1"]:
		gwVersion = "v1beta1"
	}
	cap.GatewayAPIVersion = gwVersion
	cap.HasEnvoyProxy = served["gateway.envoyproxy.io"]

	gwPresent := gwVersion != ""
	if !gwPresent && !cap.CiliumPresent {
		cap.Base = Base{Tier: Absent, Reason: "no Gateway API or Cilium CRDs installed"}
		return cap
	}

	// Healthy requires Gateway API AND its data-plane operator (EnvoyProxy).
	healthy := gwPresent && cap.HasEnvoyProxy
	cap.Base.Tier = Classify(true, healthy)
	if !healthy {
		if gwPresent && !cap.HasEnvoyProxy {
			cap.Base.Reason = "Gateway API present but no EnvoyProxy (data plane) installed"
		} else if !gwPresent {
			cap.Base.Reason = "Cilium present but Gateway API not installed"
		}
	}
	return cap
}

// controllerHealthy reports whether a controller Deployment has its desired
// replicas available.
func (d *Detector) controllerHealthy(ctx context.Context, ns, name string) (bool, string) {
	dep, err := d.cs.AppsV1().Deployments(ns).Get(ctx, name, metaGetOptions())
	if err != nil {
		return false, fmt.Sprintf("%s deployment not found", name)
	}
	want := int32(1)
	if dep.Spec.Replicas != nil {
		want = *dep.Spec.Replicas
	}
	if dep.Status.AvailableReplicas < want {
		return false, fmt.Sprintf("%s is not ready (%d/%d available)", name, dep.Status.AvailableReplicas, want)
	}
	return true, ""
}
```

- [ ] **Step 4: Add the import helper**

In `internal/capability/detector.go`, add to the import block and a tiny helper so the Get options are explicit:

```go
import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func metaGetOptions() metav1.GetOptions { return metav1.GetOptions{} }
```

(Place the `metav1` import alongside the others; keep one import block.)

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/capability/ -v`
Expected: PASS (all detector tests + Task 6 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/capability/
git commit -m "feat: capability detector with presence and controller health"
```

---

### Task 8: Count helpers (node readiness, pod count)

Pure functions so counting logic is tested independently of informer wiring.

**Files:**
- Create: `internal/fleet/counts.go`
- Test: `internal/fleet/counts_test.go`

- [ ] **Step 1: Write the failing test**

```go
package fleet

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func node(name string, ready bool) *corev1.Node {
	cond := corev1.NodeCondition{Type: corev1.NodeReady, Status: corev1.ConditionFalse}
	if ready {
		cond.Status = corev1.ConditionTrue
	}
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status:     corev1.NodeStatus{Conditions: []corev1.NodeCondition{cond}},
	}
}

func TestNodeReadiness(t *testing.T) {
	nodes := []*corev1.Node{node("a", true), node("b", true), node("c", false)}
	ready, total := NodeReadiness(nodes)
	if ready != 2 || total != 3 {
		t.Fatalf("want 2/3, got %d/%d", ready, total)
	}
}

func TestNodeReadinessEmpty(t *testing.T) {
	ready, total := NodeReadiness(nil)
	if ready != 0 || total != 0 {
		t.Fatalf("want 0/0, got %d/%d", ready, total)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestNodeReadiness -v`
Expected: FAIL - `undefined: NodeReadiness`.

- [ ] **Step 3: Write minimal implementation**

```go
package fleet

import corev1 "k8s.io/api/core/v1"

// NodeReadiness returns (ready, total) where ready counts nodes whose Ready
// condition is True.
func NodeReadiness(nodes []*corev1.Node) (ready, total int) {
	total = len(nodes)
	for _, n := range nodes {
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
				ready++
				break
			}
		}
	}
	return ready, total
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run TestNodeReadiness -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/counts.go internal/fleet/counts_test.go
git commit -m "feat: node readiness counting"
```

---

### Task 9: ClusterConn with typed node + metadata-only pod informers

The conn owns informers, derives a `Snapshot`, and tracks staleness via the clock.

**Files:**
- Create: `internal/fleet/snapshot.go`
- Create: `internal/fleet/conn.go`
- Test: `internal/fleet/conn_test.go`

- [ ] **Step 1: Write the Snapshot type**

`internal/fleet/snapshot.go`:
```go
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
	Capabilities capability.Set
}
```

- [ ] **Step 2: Write the failing test**

`internal/fleet/conn_test.go`:
```go
package fleet

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
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

	conn := NewClusterConn("plt-sea-prd-we-aks-01", typed, mclient, det, clock.Real{})
	conn.Start(ctx)

	// Wait for initial sync to settle.
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

var _ = schema.GroupVersionResource{} // keep import if unused after edits
var _ = runtime.Object(nil)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestClusterConn -v`
Expected: FAIL - `undefined: NewClusterConn`.

- [ ] **Step 4: Write minimal implementation**

`internal/fleet/conn.go`:
```go
package fleet

import (
	"context"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

	mu       sync.RWMutex
	state    ConnState
	reason   string
	lastSync time.Time
	caps     capability.Set
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

		// Reflect capability health into the conn state.
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

// snapshot count fields (kept on the struct so Snapshot is a pure read).
// Declared here to keep the struct definition above focused.
var _ = metav1.PartialObjectMetadata{}
```

Add these fields to the `ClusterConn` struct (next to `caps`):
```go
	snapNodesReady int
	snapNodesTotal int
	snapPods       int
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run TestClusterConn -v`
Expected: PASS. If `metadatafake.NewTestScheme` is unavailable in the pinned client-go, substitute:
```go
import "k8s.io/apimachinery/pkg/runtime"
mscheme := runtime.NewScheme()
_ = metav1.AddMetaToScheme(mscheme)
```
and adjust the test accordingly.

- [ ] **Step 6: Commit**

```bash
git add internal/fleet/snapshot.go internal/fleet/conn.go internal/fleet/conn_test.go
git commit -m "feat: ClusterConn with typed node and metadata-only pod informers"
```

---

### Task 10: Registry with per-conn isolation

The registry builds conns from config via an injected factory, starts them, and exposes snapshots. A failing conn must not affect the others.

**Files:**
- Create: `internal/fleet/registry.go`
- Test: `internal/fleet/registry_test.go`

- [ ] **Step 1: Write the failing test**

```go
package fleet

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/config"
)

type fakeConn struct {
	name  string
	snap  Snapshot
	start func()
}

func (f *fakeConn) Name() string                 { return f.name }
func (f *fakeConn) Start(ctx context.Context)     { if f.start != nil { f.start() } }
func (f *fakeConn) Snapshot() Snapshot            { return f.snap }

func TestRegistryStartsAllConnsAndIsolatesFailure(t *testing.T) {
	cfg := &config.Config{Clusters: []config.ClusterConfig{
		{Name: "good-1"}, {Name: "bad"}, {Name: "good-2"},
	}}

	factory := func(cc config.ClusterConfig) (Conn, error) {
		switch cc.Name {
		case "bad":
			// Simulate a conn that fails to construct (e.g. bad kubeconfig).
			return nil, context.DeadlineExceeded
		case "good-1":
			return &fakeConn{name: "good-1", snap: Snapshot{Name: "good-1", State: Synced}}, nil
		default:
			return &fakeConn{name: "good-2", snap: Snapshot{Name: "good-2", State: Synced}}, nil
		}
	}

	reg := NewRegistry(cfg, factory)
	reg.Start(context.Background())

	snaps := reg.Snapshots()
	if len(snaps) != 3 {
		t.Fatalf("want 3 snapshots, got %d", len(snaps))
	}
	byName := map[string]Snapshot{}
	for _, s := range snaps {
		byName[s.Name] = s
	}
	if byName["good-1"].State != Synced || byName["good-2"].State != Synced {
		t.Fatalf("good conns should be Synced: %+v", byName)
	}
	if byName["bad"].State != Failed {
		t.Fatalf("bad conn should be Failed, got %v", byName["bad"].State)
	}
	if byName["bad"].Reason == "" {
		t.Fatal("failed conn must carry a reason")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestRegistry -v`
Expected: FAIL - `undefined: NewRegistry`.

- [ ] **Step 3: Write minimal implementation**

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run TestRegistry -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/registry.go internal/fleet/registry_test.go
git commit -m "feat: cluster registry with per-conn failure isolation"
```

---

### Task 11: Fleet aggregation with partial-failure annotation

Cross-cluster summary computed at the data layer (Q3), annotating how many clusters answered.

**Files:**
- Create: `internal/fleet/aggregate.go`
- Test: `internal/fleet/aggregate_test.go`

- [ ] **Step 1: Write the failing test**

```go
package fleet

import "testing"

func TestSummarize(t *testing.T) {
	snaps := []Snapshot{
		{Name: "a", State: Synced, NodesReady: 12, NodesTotal: 12, Pods: 487},
		{Name: "b", State: Degraded, NodesReady: 10, NodesTotal: 10, Pods: 412},
		{Name: "c", State: Failed},
	}
	sum := Summarize(snaps)
	if sum.TotalClusters != 3 {
		t.Fatalf("want 3 total, got %d", sum.TotalClusters)
	}
	if sum.Answered != 2 {
		t.Fatalf("want 2 answered (Synced+Degraded), got %d", sum.Answered)
	}
	if sum.TotalPods != 899 {
		t.Fatalf("want 899 pods, got %d", sum.TotalPods)
	}
	if sum.NodesReady != 22 || sum.NodesTotal != 22 {
		t.Fatalf("want 22/22 nodes, got %d/%d", sum.NodesReady, sum.NodesTotal)
	}
	if !sum.Partial {
		t.Fatal("want Partial true when a cluster failed")
	}
}

func TestSummarizeComplete(t *testing.T) {
	snaps := []Snapshot{{Name: "a", State: Synced}, {Name: "b", State: Synced}}
	sum := Summarize(snaps)
	if sum.Partial {
		t.Fatal("want Partial false when all answered")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestSummarize -v`
Expected: FAIL - `undefined: Summarize`.

- [ ] **Step 3: Write minimal implementation**

```go
package fleet

// FleetSummary is the aggregated fleet state. Answered counts clusters whose
// data is usable (Synced or Degraded); Partial is true when any cluster did not
// answer.
type FleetSummary struct {
	TotalClusters int
	Answered      int
	NodesReady    int
	NodesTotal    int
	TotalPods     int
	Partial       bool
}

func answered(s ConnState) bool { return s == Synced || s == Degraded || s == Stale }

func Summarize(snaps []Snapshot) FleetSummary {
	sum := FleetSummary{TotalClusters: len(snaps)}
	for _, s := range snaps {
		if !answered(s.State) {
			continue
		}
		sum.Answered++
		sum.NodesReady += s.NodesReady
		sum.NodesTotal += s.NodesTotal
		sum.TotalPods += s.Pods
	}
	sum.Partial = sum.Answered < sum.TotalClusters
	return sum
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run TestSummarize -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/aggregate.go internal/fleet/aggregate_test.go
git commit -m "feat: fleet aggregation with partial-failure annotation"
```

---

### Task 12: Production conn factory (wires real clients)

Bridges config -> rest.Config -> typed + metadata clients -> ClusterConn.

**Files:**
- Create: `internal/fleet/factory.go`
- Test: `internal/fleet/factory_test.go`

- [ ] **Step 1: Write the failing test**

```go
package fleet

import (
	"path/filepath"
	"testing"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func TestDefaultFactoryBuildsConn(t *testing.T) {
	cc := config.ClusterConfig{
		Name:       "plt-sea-prd-we-aks-01",
		Context:    "prd-we",
		Kubeconfig: filepath.Join("..", "cluster", "testdata", "kubeconfig.yaml"),
	}
	f := DefaultConnFactory(clock.Real{})
	conn, err := f(cc)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.Name() != "plt-sea-prd-we-aks-01" {
		t.Fatalf("want name set, got %q", conn.Name())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run TestDefaultFactory -v`
Expected: FAIL - `undefined: DefaultConnFactory`.

- [ ] **Step 3: Write minimal implementation**

```go
package fleet

import (
	"fmt"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/cluster"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

// DefaultConnFactory returns a ConnFactory that builds real client-go clients.
func DefaultConnFactory(clk clock.Clock) ConnFactory {
	return func(cc config.ClusterConfig) (Conn, error) {
		rc, err := cluster.RESTConfig(cc)
		if err != nil {
			return nil, err
		}
		typed, err := kubernetes.NewForConfig(rc)
		if err != nil {
			return nil, fmt.Errorf("typed client for %q: %w", cc.Name, err)
		}
		mclient, err := metadata.NewForConfig(rc)
		if err != nil {
			return nil, fmt.Errorf("metadata client for %q: %w", cc.Name, err)
		}
		det := capability.NewDetector(typed)
		return NewClusterConn(cc.Name, typed, mclient, det, clk), nil
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/fleet/ -run TestDefaultFactory -v`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `go test ./... && go vet ./...`
Expected: all packages PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/fleet/factory.go internal/fleet/factory_test.go
git commit -m "feat: default conn factory wiring real client-go clients"
```

---

### Task 13: Headless smoke command

A tiny CLI to verify the foundation against real clusters - the manual proof of fan-out, isolation, and capability detection before any UI exists.

**Files:**
- Create: `cmd/klyxctl/main.go`

- [ ] **Step 1: Write the command**

```go
// Command klyxctl is a headless smoke tool for the Klyx data foundation.
// Usage: klyxctl fleet --config path/to/fleet.yaml
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/fleet"
)

func main() {
	cfgPath := flag.String("config", "", "path to Klyx fleet config")
	wait := flag.Duration("wait", 5*time.Second, "how long to let connections sync")
	flag.Parse()

	if *cfgPath == "" {
		fmt.Fprintln(os.Stderr, "error: --config is required")
		os.Exit(2)
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reg := fleet.NewRegistry(cfg, fleet.DefaultConnFactory(clock.Real{}))
	reg.Start(ctx)

	time.Sleep(*wait) // give informers time to sync for this one-shot tool

	snaps := reg.Snapshots()
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CLUSTER\tSTATE\tNODES\tPODS\tGITOPS\tNETWORK\tREASON")
	for _, s := range snaps {
		fmt.Fprintf(w, "%s\t%s\t%d/%d\t%d\t%s\t%s\t%s\n",
			s.Name, s.State,
			s.NodesReady, s.NodesTotal, s.Pods,
			s.Capabilities.GitOps.Tier, s.Capabilities.Network.Tier,
			s.Reason)
	}
	w.Flush()

	sum := fleet.Summarize(snaps)
	fmt.Printf("\nfleet: %d/%d answered, %d/%d nodes ready, %d pods, partial=%v\n",
		sum.Answered, sum.TotalClusters, sum.NodesReady, sum.NodesTotal, sum.TotalPods, sum.Partial)
}
```

- [ ] **Step 2: Build it**

Run: `go build ./cmd/klyxctl/`
Expected: builds clean, produces `klyxctl` binary.

- [ ] **Step 3: Manual verification (real clusters)**

With a real `fleet.yaml` pointing at >=2 reachable clusters:
```bash
go run ./cmd/klyxctl/ fleet --config ~/.config/klyx/fleet.yaml --wait 8s
```
Expected: a table with one row per cluster, correct node/pod counts, capability tiers, and the fleet summary line.

**Isolation check:** drop one cluster's connectivity (disconnect VPN, or point one entry at an unreachable context) and re-run. Expected: that row shows `Failed` with a reason while the others stay `Synced`/`Degraded`, and the summary shows `partial=true`.

- [ ] **Step 4: Commit**

```bash
git add cmd/klyxctl/
git commit -m "feat: headless klyxctl fleet smoke command"
```

---

## Self-Review

**Spec coverage (against `2026-06-03-klyx-foundation-design.md`):**

- Section 2.1 Klyx-owned config → Task 3 (config types, tags, metrics, grouping fields). ✓
- Section 2.5 / Section 8 single vs >=2 clusters → Registry (Task 10) supports 1..N; Task 13 manual check exercises >=2 and isolation. ✓
- Section 4 spine: registry/conn, lazy-on-connect, metadata-only pods, typed nodes, staleness via clock, aggregation at data layer → Tasks 8-12. ✓
- Section 5 capability tiering + presence/health + Gateway-without-EnvoyProxy=Degraded + version pinning → Tasks 6-7. ✓
- Section 9 error handling: per-conn isolation, Failed with reason, cache-sync failure → Tasks 9-10. ✓ Watch-drop→Stale transition is defined in the FSM (Task 5); wiring a live watch-drop detector is deferred to the metrics/staleness slice and noted below.
- Section 9 testing: envtest/fake clientset, table-driven capability fixtures, fan-out/isolation test, injected clock → Tasks 2,7,9,10. ✓

**Deliberately deferred (out of Plan A scope, per spec):** metrics/PromQL client (Section 6), GitOps drift models and counts (Section 7), the Wails/React UI and fleet cards (Plan B), and the live watch-drop→Stale detector (depends on informer event wiring that pairs naturally with the metrics staleness tick). These are not gaps in Plan A; they are subsequent slices.

**Placeholder scan:** no TBD/TODO; every code step contains full code. The one conditional is Task 9 Step 5's documented fallback for `metadatafake.NewTestScheme` across client-go versions - that is an explicit alternative, not a placeholder.

**Type consistency:** `Conn` interface (Task 9) is implemented by `ClusterConn` (Task 9) and the test `fakeConn` (Task 10), and consumed by `Registry` (Task 10) and `DefaultConnFactory` (Task 12). `Snapshot` fields (Task 9) are read identically in `Summarize` (Task 11) and `klyxctl` (Task 13). `ConnState`/`Event` names are consistent across Tasks 5, 9. `capability.Set`/`Tier` consistent across Tasks 6, 7, 9, 13.
