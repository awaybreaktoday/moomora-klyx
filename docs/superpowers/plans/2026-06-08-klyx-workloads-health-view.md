# M7-c-ii-a: Workloads health view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-cluster triage-first Workloads health view (Deploy/STS/DS sorted unhealthy-first, with pod-derived failure reasons, restarts, and Flux ownership, plus an inline pod drill-down), from Kubernetes state only — no Prometheus.

**Architecture:** A pure `internal/workloads` package classifies workloads per kind, joins their pods by selector, derives a worst-reason + 4-level health rank, and sorts. `internal/fleet` only fetches (typed apps/v1 + pods, scoped at source). `internal/appbridge` exposes a `WorkloadsService`. The frontend adds a `workloads` cluster section with a triage list and inline pod expand.

**Tech Stack:** Go 1.26, client-go typed clientset (apps/v1, core/v1), React 19 + TS + Zustand, Vitest 4, Wails v3.

**Spec:** `docs/superpowers/specs/2026-06-08-klyx-workloads-health-view-design.md`

**Honesty contract (enforced across tasks):** `desired==0 → Scaled to 0, healthy` (never red); empty/nil selector matches **zero** pods (never the namespace); restarts>0 is an *info* rank; Flux owner is an ownership-label claim, not verified owner health; rank API strings are lowercase `unhealthy|degraded|restarts|healthy`; `AgeSeconds` is derived from the `now` passed into `Assemble`, never `time.Now()` downstream.

---

## File structure

- `internal/workloads/model.go` — types (`HealthRank`, `Owner`, `Pod`, `Workload`, `severity`).
- `internal/workloads/classify.go` — per-kind status extraction + condition reason.
- `internal/workloads/reason.go` — `worstPodReason` (precedence + severity).
- `internal/workloads/assemble.go` — `Assemble` (join, rank, reason, owner, sort).
- `internal/fleet/workloads.go` — `(*ClusterConn).ListWorkloads`; `conn.go` interface.
- `internal/appbridge/workloads_dto.go`, `workloads_service.go` — DTOs + service.
- `cmd/klyx/main.go` — register `WorkloadsService`.
- frontend: `store/fleet.ts` (section + slice), `chrome/Sidebar.tsx`, `cluster/ClusterDetail.tsx`, `bridge/workloads.ts`, `cluster/WorkloadsView.tsx`.

---

## Task 1: workloads model + per-kind classify

**Files:**
- Create: `internal/workloads/model.go`, `internal/workloads/classify.go`, `internal/workloads/classify_test.go`

- [ ] **Step 1: Write the failing test**

`internal/workloads/classify_test.go`:

```go
package workloads

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func i32(n int32) *int32 { return &n }

func TestClassifyDeployment(t *testing.T) {
	d := appsv1.Deployment{
		Spec: appsv1.DeploymentSpec{Replicas: i32(3)},
		Status: appsv1.DeploymentStatus{
			ReadyReplicas: 1, AvailableReplicas: 1, UpdatedReplicas: 3,
			Conditions: []appsv1.DeploymentCondition{
				{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionFalse, Reason: "MinimumReplicasUnavailable"},
				{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionTrue, Reason: "ReplicaSetUpdated"},
			},
		},
	}
	c := classifyDeployment(&d)
	if c.desired != 3 || c.ready != 1 || c.available != 1 || c.updated != 3 {
		t.Fatalf("counts: %+v", c)
	}
	// Available=False wins over a Progressing reason.
	if c.condReason != "MinimumReplicasUnavailable" {
		t.Fatalf("condReason: %q", c.condReason)
	}
}

func TestClassifyDeploymentHealthyNotNoisy(t *testing.T) {
	d := appsv1.Deployment{
		Spec: appsv1.DeploymentSpec{Replicas: i32(2)},
		Status: appsv1.DeploymentStatus{
			ReadyReplicas: 2, AvailableReplicas: 2, UpdatedReplicas: 2,
			Conditions: []appsv1.DeploymentCondition{
				{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionTrue, Reason: "MinimumReplicasAvailable"},
				{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionTrue, Reason: "NewReplicaSetAvailable"},
			},
		},
	}
	c := classifyDeployment(&d)
	// A healthy deployment must NOT surface a noisy Progressing status.
	if c.condReason != "" {
		t.Fatalf("healthy deployment should have empty condReason, got %q", c.condReason)
	}
}

func TestClassifyStatefulSetAndDaemonSet(t *testing.T) {
	s := appsv1.StatefulSet{
		Spec:   appsv1.StatefulSetSpec{Replicas: i32(3)},
		Status: appsv1.StatefulSetStatus{ReadyReplicas: 3, AvailableReplicas: 3, UpdatedReplicas: 3, CurrentRevision: "r1", UpdateRevision: "r1"},
	}
	cs := classifyStatefulSet(&s)
	if cs.desired != 3 || cs.ready != 3 {
		t.Fatalf("sts counts: %+v", cs)
	}

	ds := appsv1.DaemonSet{
		Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: 5, NumberReady: 4, NumberAvailable: 4, UpdatedNumberScheduled: 5, NumberUnavailable: 1},
	}
	cd := classifyDaemonSet(&ds)
	if cd.desired != 5 || cd.ready != 4 || cd.condReason != "Degraded · 1 unavailable" {
		t.Fatalf("ds: %+v", cd)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/workloads/ -run Classify -v`
Expected: FAIL — package/functions undefined.

- [ ] **Step 3: Implement model + classify**

`internal/workloads/model.go`:

```go
// Package workloads turns Kubernetes workload objects (Deploy/STS/DS) plus their
// pods into a health-ranked, triage-sorted view. Pure of client-go clients: it
// operates on API structs and is fixture-testable.
package workloads

// HealthRank is the triage ordering; lower value sorts nearer the top (worse).
type HealthRank int

const (
	Unhealthy HealthRank = iota // ready==0 (desired>0), or an active hard failure
	Degraded                    // ready<desired, rolling out / benign, no hard failure
	Restarts                    // ready==desired but containers restarted / recovered OOM (info)
	Healthy                     // ready==desired, no restarts; incl. desired==0 "Scaled to 0"
)

// String is the pinned lowercase API value (no title-case, no UI wording).
func (r HealthRank) String() string {
	switch r {
	case Unhealthy:
		return "unhealthy"
	case Degraded:
		return "degraded"
	case Restarts:
		return "restarts"
	default:
		return "healthy"
	}
}

type Owner struct {
	Kind, Namespace, Name string // "Kustomization" / "HelmRelease"
}

type Pod struct {
	Name       string
	Ready      bool
	Restarts   int
	Reason     string // worst container/pod reason, "" if running clean
	Node       string
	AgeSeconds int
}

type Workload struct {
	Kind, Namespace, Name              string
	Desired, Ready, Available, Updated int
	Restarts                           int
	Reason                             string // single human-facing status string
	Rank                               HealthRank
	GitOps                             *Owner
	Pods                               []Pod
}
```

`internal/workloads/classify.go`:

```go
package workloads

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

// classified holds the per-kind status extraction.
type classified struct {
	desired, ready, available, updated int
	condReason                         string // failure/rollout reason, "" when healthy
}

func replicas(p *int32) int {
	if p == nil {
		return 1
	}
	return int(*p)
}

func classifyDeployment(d *appsv1.Deployment) classified {
	c := classified{
		desired:   replicas(d.Spec.Replicas),
		ready:     int(d.Status.ReadyReplicas),
		available: int(d.Status.AvailableReplicas),
		updated:   int(d.Status.UpdatedReplicas),
	}
	// Condition priority: ReplicaFailure=True > Available=False > Progressing=False
	// > Progressing rolling. Healthy NewReplicaSetAvailable is NOT surfaced.
	var avail, prog *appsv1.DeploymentCondition
	for i := range d.Status.Conditions {
		cond := &d.Status.Conditions[i]
		switch cond.Type {
		case "ReplicaFailure":
			if cond.Status == corev1.ConditionTrue {
				c.condReason = cond.Reason
				return c
			}
		case appsv1.DeploymentAvailable:
			avail = cond
		case appsv1.DeploymentProgressing:
			prog = cond
		}
	}
	if avail != nil && avail.Status == corev1.ConditionFalse {
		c.condReason = avail.Reason
		return c
	}
	if prog != nil && prog.Status == corev1.ConditionFalse {
		c.condReason = prog.Reason
		return c
	}
	if prog != nil && prog.Status == corev1.ConditionTrue && prog.Reason != "NewReplicaSetAvailable" {
		c.condReason = fmt.Sprintf("Rolling out · %d updated", c.updated)
	}
	return c
}

func classifyStatefulSet(s *appsv1.StatefulSet) classified {
	c := classified{
		desired:   replicas(s.Spec.Replicas),
		ready:     int(s.Status.ReadyReplicas),
		available: int(s.Status.AvailableReplicas),
		updated:   int(s.Status.UpdatedReplicas),
	}
	if s.Status.CurrentRevision != "" && s.Status.UpdateRevision != "" && s.Status.CurrentRevision != s.Status.UpdateRevision {
		c.condReason = fmt.Sprintf("Rolling out · %d updated", c.updated)
	}
	return c
}

func classifyDaemonSet(ds *appsv1.DaemonSet) classified {
	c := classified{
		desired:   int(ds.Status.DesiredNumberScheduled),
		ready:     int(ds.Status.NumberReady),
		available: int(ds.Status.NumberAvailable),
		updated:   int(ds.Status.UpdatedNumberScheduled),
	}
	if ds.Status.NumberUnavailable > 0 {
		c.condReason = fmt.Sprintf("Degraded · %d unavailable", ds.Status.NumberUnavailable)
	}
	return c
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/workloads/ -run Classify -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/workloads/model.go internal/workloads/classify.go internal/workloads/classify_test.go
git commit -m "feat(workloads): model + per-kind classify (condition priority)"
```

---

## Task 2: worstPodReason (precedence + severity)

**Files:**
- Create: `internal/workloads/reason.go`, `internal/workloads/reason_test.go`

- [ ] **Step 1: Write the failing test**

`internal/workloads/reason_test.go`:

```go
package workloads

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func waitingPod(reason string) corev1.Pod {
	return corev1.Pod{Status: corev1.PodStatus{
		Phase:             corev1.PodRunning,
		ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}},
	}}
}

func TestWorstPodReason(t *testing.T) {
	// CrashLoopBackOff (hard) beats a benign ContainerCreating in another pod.
	r, sev := worstPodReason([]corev1.Pod{waitingPod("ContainerCreating"), waitingPod("CrashLoopBackOff")})
	if r != "CrashLoopBackOff" || sev != sevHard {
		t.Fatalf("got %q/%v", r, sev)
	}

	// OOMKilled in lastState while the container is currently Running -> historical.
	oom := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
		State:     corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled"}},
	}}}}
	r, sev = worstPodReason([]corev1.Pod{oom})
	if r != "OOMKilled" || sev != sevHistorical {
		t.Fatalf("oom got %q/%v", r, sev)
	}

	// Unschedulable from PodScheduled=False.
	pend := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{
		{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable"},
	}}}
	r, sev = worstPodReason([]corev1.Pod{pend})
	if r != "Unschedulable" || sev != sevHard {
		t.Fatalf("pend got %q/%v", r, sev)
	}

	// Clean pod -> none.
	clean := corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}}}
	r, sev = worstPodReason([]corev1.Pod{clean})
	if r != "" || sev != sevNone {
		t.Fatalf("clean got %q/%v", r, sev)
	}

	// Empty pod set -> none.
	if r, sev := worstPodReason(nil); r != "" || sev != sevNone {
		t.Fatalf("empty got %q/%v", r, sev)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/workloads/ -run WorstPodReason -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement**

`internal/workloads/reason.go`:

```go
package workloads

import corev1 "k8s.io/api/core/v1"

type severity int

const (
	sevNone       severity = iota
	sevBenign              // ContainerCreating, PodInitializing
	sevHistorical         // OOMKilled in lastState while currently running (explains restarts)
	sevHard               // currently-broken: CrashLoop, ImagePull, CreateContainer, Unschedulable, Failed
)

// hardRank orders hard reasons for display when several are present (higher wins).
var hardRank = map[string]int{
	"CrashLoopBackOff":           70,
	"OOMKilled":                  60, // active terminated OOM (not lastState-while-running)
	"ImagePullBackOff":           50,
	"ErrImagePull":               50,
	"CreateContainerConfigError": 40,
	"CreateContainerError":       40,
	"InvalidImageName":           40,
	"Unschedulable":              30,
	"Failed":                     20,
}

// worstPodReason returns the single worst reason across a workload's pods and its
// severity. Reads container waiting/terminated state AND pod phase/conditions.
func worstPodReason(pods []corev1.Pod) (string, severity) {
	bestReason := ""
	bestSev := sevNone
	bestHard := -1
	benign := ""
	historical := ""

	consider := func(reason string, sev severity) {
		switch sev {
		case sevHard:
			if r := hardRank[reason]; r > bestHard {
				bestHard, bestReason, bestSev = r, reason, sevHard
			}
		case sevHistorical:
			if bestSev < sevHistorical {
				historical = reason
			}
		case sevBenign:
			if bestSev < sevBenign && benign == "" {
				benign = reason
			}
		}
	}

	for i := range pods {
		p := &pods[i]
		// Pod-level: unschedulable / failed.
		if p.Status.Phase == corev1.PodFailed {
			consider("Failed", sevHard)
		}
		for _, cond := range p.Status.Conditions {
			if cond.Type == corev1.PodScheduled && cond.Status == corev1.ConditionFalse && cond.Reason == "Unschedulable" {
				consider("Unschedulable", sevHard)
			}
		}
		// Container-level.
		for _, cs := range p.Status.ContainerStatuses {
			if w := cs.State.Waiting; w != nil && w.Reason != "" {
				switch w.Reason {
				case "ContainerCreating", "PodInitializing":
					consider(w.Reason, sevBenign)
				default:
					consider(w.Reason, sevHard) // CrashLoopBackOff, ImagePullBackOff, etc.
				}
			}
			if t := cs.State.Terminated; t != nil && t.Reason == "OOMKilled" {
				consider("OOMKilled", sevHard) // currently terminated by OOM
			}
			// OOMKilled in lastState while currently running -> historical signal.
			if cs.State.Running != nil && cs.LastTerminationState.Terminated != nil &&
				cs.LastTerminationState.Terminated.Reason == "OOMKilled" {
				consider("OOMKilled", sevHistorical)
			}
		}
	}

	if bestSev == sevHard {
		return bestReason, sevHard
	}
	if historical != "" {
		return historical, sevHistorical
	}
	if benign != "" {
		return benign, sevBenign
	}
	return "", sevNone
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/workloads/ -run WorstPodReason -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/workloads/reason.go internal/workloads/reason_test.go
git commit -m "feat(workloads): worst-pod-reason precedence + severity"
```

---

## Task 3: Assemble (join, rank, reason, owner, sort)

**Files:**
- Create: `internal/workloads/assemble.go`, `internal/workloads/assemble_test.go`

- [ ] **Step 1: Write the failing test**

`internal/workloads/assemble_test.go`:

```go
package workloads

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func sel(m map[string]string) *metav1.LabelSelector { return &metav1.LabelSelector{MatchLabels: m} }

func pod(ns, name string, labels map[string]string, ready bool, restarts int32, waiting string) corev1.Pod {
	cs := corev1.ContainerStatus{RestartCount: restarts}
	if waiting != "" {
		cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: waiting}
	} else {
		cs.State.Running = &corev1.ContainerStateRunning{}
	}
	readyCond := corev1.ConditionTrue
	if !ready {
		readyCond = corev1.ConditionFalse
	}
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels, CreationTimestamp: metav1.NewTime(time.Unix(0, 0))},
		Spec:       corev1.PodSpec{NodeName: "node-1"},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: readyCond}},
			ContainerStatuses: []corev1.ContainerStatus{cs},
		},
	}
}

func TestAssembleRankAndJoinAndOwner(t *testing.T) {
	now := time.Unix(600, 0)
	broken := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ollama-prod", Name: "ollama",
			Labels: map[string]string{"kustomize.toolkit.fluxcd.io/name": "ollama", "kustomize.toolkit.fluxcd.io/namespace": "flux-system"}},
		Spec:   appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "ollama"})},
		Status: appsv1.DeploymentStatus{ReadyReplicas: 0},
	}
	healthy := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "monitoring", Name: "grafana"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1), Selector: sel(map[string]string{"app": "grafana"})},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	pods := []corev1.Pod{
		pod("ollama-prod", "ollama-x", map[string]string{"app": "ollama"}, false, 7, "CrashLoopBackOff"),
		pod("monitoring", "grafana-y", map[string]string{"app": "grafana"}, true, 0, ""),
	}

	out := Assemble([]appsv1.Deployment{healthy, broken}, nil, nil, pods, true, now)
	if len(out) != 2 {
		t.Fatalf("want 2, got %d", len(out))
	}
	// Triage: broken first.
	if out[0].Name != "ollama" || out[0].Rank != Unhealthy || out[0].Reason != "CrashLoopBackOff" || out[0].Restarts != 7 {
		t.Fatalf("row0: %+v", out[0])
	}
	if out[0].GitOps == nil || out[0].GitOps.Kind != "Kustomization" || out[0].GitOps.Name != "ollama" {
		t.Fatalf("owner: %+v", out[0].GitOps)
	}
	if len(out[0].Pods) != 1 || out[0].Pods[0].AgeSeconds != 600 {
		t.Fatalf("pods/age: %+v", out[0].Pods)
	}
	if out[1].Name != "grafana" || out[1].Rank != Healthy || out[1].GitOps != nil {
		t.Fatalf("row1: %+v", out[1])
	}
}

func TestAssembleScaledToZeroAndEmptySelector(t *testing.T) {
	now := time.Unix(0, 0)
	scaled := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "scaled"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(0), Selector: sel(map[string]string{"app": "scaled"})},
		Status:     appsv1.DeploymentStatus{},
	}
	// Empty selector must match ZERO pods (not the whole namespace).
	noSel := appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "x", Name: "nosel"},
		Spec:       appsv1.DeploymentSpec{Replicas: i32(1), Selector: &metav1.LabelSelector{}},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
	}
	pods := []corev1.Pod{pod("x", "stray", map[string]string{"app": "whatever"}, true, 3, "")}

	out := Assemble([]appsv1.Deployment{scaled, noSel}, nil, nil, pods, false, now)
	byName := map[string]Workload{}
	for _, w := range out {
		byName[w.Name] = w
	}
	if byName["scaled"].Rank != Healthy || byName["scaled"].Reason != "Scaled to 0" {
		t.Fatalf("scaled: %+v", byName["scaled"])
	}
	if len(byName["nosel"].Pods) != 0 || byName["nosel"].Restarts != 0 {
		t.Fatalf("empty selector matched pods: %+v", byName["nosel"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/workloads/ -run Assemble -v`
Expected: FAIL — `Assemble` undefined.

- [ ] **Step 3: Implement**

`internal/workloads/assemble.go`:

```go
package workloads

import (
	"sort"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// Assemble joins workloads with their pods and derives health, sorted
// triage-first (Rank, then namespace/name). fluxPresent gates owner extraction.
// AgeSeconds is computed from now.
func Assemble(deploys []appsv1.Deployment, stss []appsv1.StatefulSet, dss []appsv1.DaemonSet,
	pods []corev1.Pod, fluxPresent bool, now time.Time) []Workload {

	out := make([]Workload, 0, len(deploys)+len(stss)+len(dss))
	for i := range deploys {
		d := &deploys[i]
		out = append(out, build("Deployment", d.Namespace, d.Name, d.Labels, d.Spec.Selector, classifyDeployment(d), pods, fluxPresent, now))
	}
	for i := range stss {
		s := &stss[i]
		out = append(out, build("StatefulSet", s.Namespace, s.Name, s.Labels, s.Spec.Selector, classifyStatefulSet(s), pods, fluxPresent, now))
	}
	for i := range dss {
		ds := &dss[i]
		out = append(out, build("DaemonSet", ds.Namespace, ds.Name, ds.Labels, ds.Spec.Selector, classifyDaemonSet(ds), pods, fluxPresent, now))
	}

	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Rank != out[b].Rank {
			return out[a].Rank < out[b].Rank
		}
		if out[a].Namespace != out[b].Namespace {
			return out[a].Namespace < out[b].Namespace
		}
		return out[a].Name < out[b].Name
	})
	return out
}

func build(kind, ns, name string, objLabels map[string]string, selector *metav1.LabelSelector,
	c classified, allPods []corev1.Pod, fluxPresent bool, now time.Time) Workload {

	w := Workload{Kind: kind, Namespace: ns, Name: name,
		Desired: c.desired, Ready: c.ready, Available: c.available, Updated: c.updated}

	matched := matchPods(ns, selector, allPods)
	w.Pods = make([]Pod, 0, len(matched))
	for _, p := range matched {
		pr, _ := worstPodReason([]corev1.Pod{*p})
		w.Restarts += podRestarts(p)
		w.Pods = append(w.Pods, Pod{
			Name: p.Name, Ready: podReady(p), Restarts: podRestarts(p), Reason: pr,
			Node: p.Spec.NodeName, AgeSeconds: ageSeconds(p.CreationTimestamp.Time, now),
		})
	}

	reason, sev := worstPodReason(deref(matched))
	w.Rank = rankOf(c.desired, c.ready, w.Restarts, sev)
	w.Reason = displayReason(kind, c, reason)

	if fluxPresent {
		w.GitOps = extractOwner(objLabels)
	}
	return w
}

// matchPods returns pods in ns matching selector. A nil or EMPTY selector matches
// ZERO pods (never the whole namespace).
func matchPods(ns string, selector *metav1.LabelSelector, allPods []corev1.Pod) []*corev1.Pod {
	if selector == nil || (len(selector.MatchLabels) == 0 && len(selector.MatchExpressions) == 0) {
		return nil
	}
	s, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return nil
	}
	var out []*corev1.Pod
	for i := range allPods {
		p := &allPods[i]
		if p.Namespace == ns && s.Matches(labels.Set(p.Labels)) {
			out = append(out, p)
		}
	}
	return out
}

func deref(ps []*corev1.Pod) []corev1.Pod {
	out := make([]corev1.Pod, len(ps))
	for i, p := range ps {
		out[i] = *p
	}
	return out
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func podRestarts(p *corev1.Pod) int {
	n := 0
	for _, cs := range p.Status.ContainerStatuses {
		n += int(cs.RestartCount)
	}
	return n
}

func ageSeconds(created, now time.Time) int {
	if created.IsZero() {
		return 0
	}
	d := int(now.Sub(created).Seconds())
	if d < 0 {
		return 0
	}
	return d
}

func rankOf(desired, ready, restarts int, sev severity) HealthRank {
	if desired == 0 {
		return Healthy
	}
	if ready == 0 {
		return Unhealthy
	}
	if ready < desired {
		if sev == sevHard {
			return Unhealthy
		}
		return Degraded
	}
	// ready == desired
	if restarts > 0 || sev == sevHistorical {
		return Restarts
	}
	return Healthy
}

func displayReason(kind string, c classified, podReason string) string {
	if c.desired == 0 {
		return "Scaled to 0"
	}
	if podReason != "" {
		return podReason
	}
	if c.condReason != "" {
		return c.condReason
	}
	if c.ready == c.desired {
		// Speak each kind's vocabulary: Deployments have an "Available" condition;
		// StatefulSets/DaemonSets are "Ready".
		if kind == "Deployment" {
			return "Available"
		}
		return "Ready"
	}
	return ""
}

func extractOwner(l map[string]string) *Owner {
	if n := l["kustomize.toolkit.fluxcd.io/name"]; n != "" {
		return &Owner{Kind: "Kustomization", Namespace: l["kustomize.toolkit.fluxcd.io/namespace"], Name: n}
	}
	if n := l["helm.toolkit.fluxcd.io/name"]; n != "" {
		return &Owner{Kind: "HelmRelease", Namespace: l["helm.toolkit.fluxcd.io/namespace"], Name: n}
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/workloads/ -v`
Expected: PASS (whole package).

- [ ] **Step 5: Commit**

```bash
git add internal/workloads/assemble.go internal/workloads/assemble_test.go
git commit -m "feat(workloads): Assemble — join, rank, reason, owner, triage sort"
```

---

## Task 4: fleet ListWorkloads

**Files:**
- Create: `internal/fleet/workloads.go`, `internal/fleet/workloads_test.go`
- Modify: `internal/fleet/conn.go` (interface), `internal/fleet/registry_test.go` (fakeConn stub)

- [ ] **Step 1: Write the failing test**

`internal/fleet/workloads_test.go`:

```go
package fleet

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestListWorkloads(t *testing.T) {
	reps := int32(1)
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api"},
		Spec:       appsv1.DeploymentSpec{Replicas: &reps, Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: 0},
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-x", Labels: map[string]string{"app": "api"}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{
			{RestartCount: 4, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff"}}}}},
	}
	cs := fake.NewSimpleClientset(dep, pod)
	c := &ClusterConn{typed: cs, clk: clock.NewFake(time.Unix(0, 0))}
	c.caps = capability.Set{GitOps: capability.GitOpsCapability{Flux: capability.FluxInfo{Present: true}}}

	out, err := c.ListWorkloads(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Name != "api" || out[0].Rank.String() != "unhealthy" || out[0].Reason != "ImagePullBackOff" || out[0].Restarts != 4 {
		t.Fatalf("got %+v", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/fleet/ -run ListWorkloads -v`
Expected: FAIL — `ListWorkloads` undefined.

- [ ] **Step 3: Implement + interface + stub**

`internal/fleet/workloads.go`:

```go
package fleet

import (
	"context"

	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/workloads"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ListWorkloads lists Deploy/StatefulSet/DaemonSet + Pods scoped to namespace
// ("" = all; a set namespace scopes the typed list at source) and assembles
// their health. On-demand; no watch.
func (c *ClusterConn) ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, error) {
	deps, err := c.typed.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	stss, err := c.typed.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	dss, err := c.typed.AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	pods, err := c.typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	c.mu.RLock()
	fluxPresent := c.caps.GitOps.Flux.Present
	c.mu.RUnlock()

	clk := c.clk
	if clk == nil {
		clk = clock.Real{}
	}
	return workloads.Assemble(deps.Items, stss.Items, dss.Items, pods.Items, fluxPresent, clk.Now()), nil
}
```

In `internal/fleet/conn.go`, add the import `"github.com/moomora/klyx/internal/workloads"` and to the `Conn` interface:
```go
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, error)
```

In `internal/fleet/registry_test.go`, add the `fakeConn` stub (and `workloads` import):
```go
func (f *fakeConn) ListWorkloads(context.Context, string) ([]workloads.Workload, error) {
	return nil, nil
}
```

- [ ] **Step 4: Run tests + build**

Run: `go test ./internal/fleet/ -run ListWorkloads -v && go build ./internal/...`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add internal/fleet/workloads.go internal/fleet/workloads_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ListWorkloads (typed apps/v1 + pods, namespace-scoped, Flux-gated owner)"
```

---

## Task 5: appbridge WorkloadsService + DTOs + register

**Files:**
- Create: `internal/appbridge/workloads_dto.go`, `internal/appbridge/workloads_service.go`, `internal/appbridge/workloads_service_test.go`
- Modify: `cmd/klyx/main.go`

- [ ] **Step 1: Write the failing test**

`internal/appbridge/workloads_service_test.go`:

```go
package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/workloads"
)

type fakeWLConn struct{ wl []workloads.Workload }

func (f fakeWLConn) ListWorkloads(context.Context, string) ([]workloads.Workload, error) {
	return f.wl, nil
}

func TestListWorkloadsDTO(t *testing.T) {
	t.Run("cluster miss -> empty non-nil", func(t *testing.T) {
		s := NewWorkloadsService(func(string) (WorkloadsConn, bool) { return nil, false })
		dto := s.ListWorkloads("nope", "")
		if dto.Workloads == nil || dto.Namespaces == nil {
			t.Fatal("slices must be non-nil")
		}
	})
	t.Run("maps + namespaces on all-load + rank string", func(t *testing.T) {
		conn := fakeWLConn{wl: []workloads.Workload{
			{Kind: "Deployment", Namespace: "b", Name: "x", Desired: 1, Ready: 0, Rank: workloads.Unhealthy, Reason: "CrashLoopBackOff",
				GitOps: &workloads.Owner{Kind: "Kustomization", Namespace: "flux-system", Name: "x"},
				Pods:   []workloads.Pod{{Name: "x-1", Ready: false, Restarts: 5, Reason: "CrashLoopBackOff", Node: "n1", AgeSeconds: 30}}},
			{Kind: "DaemonSet", Namespace: "a", Name: "y", Desired: 3, Ready: 3, Rank: workloads.Healthy},
		}}
		s := NewWorkloadsService(func(string) (WorkloadsConn, bool) { return conn, true })

		all := s.ListWorkloads("c", "")
		if len(all.Workloads) != 2 || all.Workloads[0].Rank != "unhealthy" {
			t.Fatalf("workloads: %+v", all.Workloads)
		}
		if all.Workloads[0].GitOps == nil || all.Workloads[0].GitOps.Name != "x" {
			t.Fatalf("owner: %+v", all.Workloads[0].GitOps)
		}
		if len(all.Workloads[0].Pods) != 1 || all.Workloads[0].Pods[0].AgeSeconds != 30 {
			t.Fatalf("pods: %+v", all.Workloads[0].Pods)
		}
		// Namespaces populated (sorted distinct) ONLY on all-load.
		if len(all.Namespaces) != 2 || all.Namespaces[0] != "a" || all.Namespaces[1] != "b" {
			t.Fatalf("namespaces: %+v", all.Namespaces)
		}
		scoped := s.ListWorkloads("c", "b")
		if len(scoped.Namespaces) != 0 {
			t.Fatalf("scoped namespaces should be empty, got %+v", scoped.Namespaces)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/appbridge/ -run ListWorkloadsDTO -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement DTOs + service**

`internal/appbridge/workloads_dto.go`:

```go
package appbridge

type OwnerDTO struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type PodDTO struct {
	Name       string `json:"name"`
	Ready      bool   `json:"ready"`
	Restarts   int    `json:"restarts"`
	Reason     string `json:"reason"`
	Node       string `json:"node"`
	AgeSeconds int    `json:"ageSeconds"`
}

type WorkloadDTO struct {
	Kind      string    `json:"kind"`
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	Desired   int       `json:"desired"`
	Ready     int       `json:"ready"`
	Available int       `json:"available"`
	Updated   int       `json:"updated"`
	Restarts  int       `json:"restarts"`
	Reason    string    `json:"reason"`
	Rank      string    `json:"rank"` // "unhealthy"|"degraded"|"restarts"|"healthy"
	GitOps    *OwnerDTO `json:"gitops"`
	Pods      []PodDTO  `json:"pods"`
}

type WorkloadsResultDTO struct {
	FluxPresent bool          `json:"fluxPresent"`
	Namespaces  []string      `json:"namespaces"` // populated only when namespace==""
	Workloads   []WorkloadDTO `json:"workloads"`
}
```

`internal/appbridge/workloads_service.go`:

```go
package appbridge

import (
	"context"
	"sort"
	"time"

	"github.com/moomora/klyx/internal/workloads"
)

const workloadsTimeout = 30 * time.Second

type WorkloadsConn interface {
	ListWorkloads(ctx context.Context, namespace string) ([]workloads.Workload, error)
}

type WorkloadsService struct {
	lookup func(string) (WorkloadsConn, bool)
}

func NewWorkloadsService(lookup func(string) (WorkloadsConn, bool)) *WorkloadsService {
	return &WorkloadsService{lookup: lookup}
}

// ListWorkloads returns the health-ranked workloads for a cluster, scoped to
// namespace ("" = all). Namespaces is the sorted distinct set of workload
// namespaces, populated ONLY on the all-namespaces load (dropdown source).
func (s *WorkloadsService) ListWorkloads(cluster, namespace string) WorkloadsResultDTO {
	out := WorkloadsResultDTO{Namespaces: []string{}, Workloads: []WorkloadDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), workloadsTimeout)
	defer cancel()
	wl, err := conn.ListWorkloads(ctx, namespace)
	if err != nil {
		return out
	}

	nsSet := map[string]bool{}
	for _, w := range wl {
		nsSet[w.Namespace] = true
		out.Workloads = append(out.Workloads, toWorkloadDTO(w))
	}
	if namespace == "" {
		for ns := range nsSet {
			out.Namespaces = append(out.Namespaces, ns)
		}
		sort.Strings(out.Namespaces)
	}
	return out
}

func toWorkloadDTO(w workloads.Workload) WorkloadDTO {
	d := WorkloadDTO{
		Kind: w.Kind, Namespace: w.Namespace, Name: w.Name,
		Desired: w.Desired, Ready: w.Ready, Available: w.Available, Updated: w.Updated,
		Restarts: w.Restarts, Reason: w.Reason, Rank: w.Rank.String(),
		Pods: make([]PodDTO, 0, len(w.Pods)),
	}
	if w.GitOps != nil {
		d.GitOps = &OwnerDTO{Kind: w.GitOps.Kind, Namespace: w.GitOps.Namespace, Name: w.GitOps.Name}
	}
	for _, p := range w.Pods {
		d.Pods = append(d.Pods, PodDTO{Name: p.Name, Ready: p.Ready, Restarts: p.Restarts, Reason: p.Reason, Node: p.Node, AgeSeconds: p.AgeSeconds})
	}
	return d
}
```

- [ ] **Step 4: Register in main.go**

In `cmd/klyx/main.go`, after the `metricsSvc` block (or any service block), add:
```go
	workloadsSvc := appbridge.NewWorkloadsService(func(name string) (appbridge.WorkloadsConn, bool) {
		c, ok := reg.Conn(name)
		if !ok {
			return nil, false
		}
		return c, true
	})
```
And in the `Services: []application.Service{...}` slice add:
```go
			application.NewService(workloadsSvc),
```

- [ ] **Step 5: Run test + build**

Run: `go test ./internal/appbridge/ -run ListWorkloadsDTO -v && go build ./internal/...`
Expected: PASS; clean build (confirms `fleet.Conn` satisfies `appbridge.WorkloadsConn`).

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/workloads_dto.go internal/appbridge/workloads_service.go internal/appbridge/workloads_service_test.go cmd/klyx/main.go
git commit -m "feat(appbridge): WorkloadsService + DTOs; register in main"
```

---

## Task 6: Frontend nav + store slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`, `cmd/klyx/frontend/src/chrome/Sidebar.tsx`, `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`
- Create: `cmd/klyx/frontend/src/bridge/workloads.ts`
- Test: `cmd/klyx/frontend/src/store/workloads.test.ts`

- [ ] **Step 1: Add the section + slice types (`store/fleet.ts`)**

Add `"workloads"` to `ClusterSection`:
```ts
export type ClusterSection = "overview" | "gitops" | "network" | "resources" | "observability" | "workloads";
```
Add to `SECTION_LABELS`:
```ts
  workloads: "Workloads",
```
Add the DTO + slice types near the other DTOs:
```ts
export type OwnerDTO = { kind: string; namespace: string; name: string };
export type PodDTO = { name: string; ready: boolean; restarts: number; reason: string; node: string; ageSeconds: number };
export type WorkloadDTO = { kind: string; namespace: string; name: string; desired: number; ready: number; available: number; updated: number; restarts: number; reason: string; rank: "unhealthy"|"degraded"|"restarts"|"healthy"; gitops: OwnerDTO | null; pods: PodDTO[] };
export type WorkloadsResultDTO = { fluxPresent: boolean; namespaces: string[]; workloads: WorkloadDTO[] };
export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
export type WorkloadsSlice = {
  cluster: string | null;
  namespace: string;        // "" = all
  items: WorkloadDTO[];
  namespaces: string[];
  fluxPresent: boolean;
  loading: boolean;
  kindFilter: Record<WorkloadKind, boolean>;
  needsAttention: boolean;
  expanded: string[];       // keys "<kind>/<namespace>/<name>"
};
```

Add to `FleetState`:
```ts
  workloads: WorkloadsSlice;
  setWorkloadsLoading: (cluster: string, namespace: string) => void;
  setWorkloads: (cluster: string, namespace: string, result: WorkloadsResultDTO) => void;
  toggleWorkloadKind: (k: WorkloadKind) => void;
  toggleNeedsAttention: () => void;
  toggleWorkloadExpand: (key: string) => void;
  clearWorkloads: () => void;
```

In the store body (near the other slices), initialize + implement:
```ts
  workloads: { cluster: null, namespace: "", items: [], namespaces: [], fluxPresent: false, loading: false,
    kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true }, needsAttention: false, expanded: [] },
  setWorkloadsLoading: (cluster, namespace) => set((s) => ({ workloads: { ...s.workloads, cluster, namespace, loading: true } })),
  setWorkloads: (cluster, namespace, result) => set((s) => {
    // namespace-list preservation: replace only on all-load; fallback to [namespace] if empty.
    let namespaces = s.workloads.namespaces;
    if (namespace === "") namespaces = result.namespaces ?? [];
    if (namespaces.length === 0 && namespace !== "") namespaces = [namespace];
    return { workloads: { ...s.workloads, cluster, namespace, items: result.workloads ?? [], namespaces, fluxPresent: result.fluxPresent, loading: false } };
  }),
  toggleWorkloadKind: (k) => set((s) => ({ workloads: { ...s.workloads, kindFilter: { ...s.workloads.kindFilter, [k]: !s.workloads.kindFilter[k] } } })),
  toggleNeedsAttention: () => set((s) => ({ workloads: { ...s.workloads, needsAttention: !s.workloads.needsAttention } })),
  toggleWorkloadExpand: (key) => set((s) => ({ workloads: { ...s.workloads, expanded: s.workloads.expanded.includes(key) ? s.workloads.expanded.filter((k) => k !== key) : [...s.workloads.expanded, key] } })),
  clearWorkloads: () => set((s) => ({ workloads: { ...s.workloads, cluster: null, items: [], namespaces: [], expanded: [], needsAttention: false, namespace: "" } })),
```

- [ ] **Step 2: Write the store unit test**

`cmd/klyx/frontend/src/store/workloads.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleet";
import type { WorkloadsResultDTO } from "./fleet";

const all: WorkloadsResultDTO = { fluxPresent: true, namespaces: ["a", "b"], workloads: [] };

describe("workloads slice", () => {
  beforeEach(() => useFleet.getState().clearWorkloads());

  it("populates namespaces on all-load and preserves them on a scoped load", () => {
    useFleet.getState().setWorkloads("c", "", all);
    expect(useFleet.getState().workloads.namespaces).toEqual(["a", "b"]);
    // scoped load (namespace != "") must NOT replace the namespace list
    useFleet.getState().setWorkloads("c", "b", { fluxPresent: true, namespaces: [], workloads: [] });
    expect(useFleet.getState().workloads.namespaces).toEqual(["a", "b"]);
  });

  it("falls back to [namespace] when first load is scoped", () => {
    useFleet.getState().setWorkloads("c", "team", { fluxPresent: false, namespaces: [], workloads: [] });
    expect(useFleet.getState().workloads.namespaces).toEqual(["team"]);
  });

  it("toggles expand by key", () => {
    useFleet.getState().toggleWorkloadExpand("Deployment/x/y");
    expect(useFleet.getState().workloads.expanded).toContain("Deployment/x/y");
    useFleet.getState().toggleWorkloadExpand("Deployment/x/y");
    expect(useFleet.getState().workloads.expanded).not.toContain("Deployment/x/y");
  });
});
```

Run: `cd cmd/klyx/frontend && npx vitest run src/store/workloads.test.ts`
Expected: FAIL first (types/setters missing), then PASS after Step 1.

- [ ] **Step 3: Bridge module (`bridge/workloads.ts`)**

Copy the binding import path from an existing bridge file (e.g. `bridge/gateway.ts`):
```ts
import { useFleet, WorkloadsResultDTO } from "../store/fleet";
import { WorkloadsService } from "../../bindings/github.com/moomora/klyx/internal/appbridge/index.js";

export async function listWorkloads(cluster: string, namespace: string): Promise<void> {
  useFleet.getState().setWorkloadsLoading(cluster, namespace);
  const r = (await WorkloadsService.ListWorkloads(cluster, namespace)) as WorkloadsResultDTO;
  // Drop a stale response if the user navigated away from this cluster.
  if (useFleet.getState().workloads.cluster !== cluster) return;
  useFleet.getState().setWorkloads(cluster, namespace, r ?? { fluxPresent: false, namespaces: [], workloads: [] });
}
```

- [ ] **Step 4: Nav wiring (Sidebar + ClusterDetail)**

In `cmd/klyx/frontend/src/chrome/Sidebar.tsx`, add an icon import (e.g. `IconBox`) to the `@tabler/icons-react` import and a `SECTION_ICONS` entry after `network`:
```ts
  { section: "workloads", Icon: IconBox },
```

In `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`, import `WorkloadsView` and add a case (mirroring `network`):
```tsx
  if (route.section === "workloads") return <WorkloadsView cluster={cluster.name} />;
```

- [ ] **Step 5: Run store test + tsc**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/workloads.test.ts && npx tsc --noEmit`
Expected: store test PASS. `tsc` will FAIL on the missing `WorkloadsView` import — that's expected; Task 7 creates it. (Do not commit a broken tsc; commit after Task 7. If you prefer a green commit here, temporarily stub `WorkloadsView.tsx` returning `null` and flesh it out in Task 7.)

Create a minimal stub so this task commits green: `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`:
```tsx
export function WorkloadsView({ cluster }: { cluster: string }) {
  return <div data-cluster={cluster} />;
}
```

Re-run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/workloads.test.ts cmd/klyx/frontend/src/bridge/workloads.ts cmd/klyx/frontend/src/chrome/Sidebar.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx cmd/klyx/frontend/src/cluster/WorkloadsView.tsx
git commit -m "feat(ui): workloads section + store slice + bridge (view stub)"
```

---

## Task 7: WorkloadsView (triage list + pod expand) + full verify

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`
- Test: `cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx`

- [ ] **Step 1: Write the failing test**

`cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { WorkloadsView } from "./WorkloadsView";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO } from "../store/fleet";

vi.mock("../bridge/workloads", () => ({ listWorkloads: vi.fn() }));

const broken: WorkloadDTO = { kind: "Deployment", namespace: "ollama-prod", name: "ollama", desired: 1, ready: 0, available: 0, updated: 1, restarts: 7, reason: "CrashLoopBackOff", rank: "unhealthy", gitops: { kind: "Kustomization", namespace: "flux-system", name: "ollama" }, pods: [{ name: "ollama-x", ready: false, restarts: 7, reason: "CrashLoopBackOff", node: "node-3", ageSeconds: 720 }] };
const healthy: WorkloadDTO = { kind: "Deployment", namespace: "monitoring", name: "grafana", desired: 1, ready: 1, available: 1, updated: 1, restarts: 0, reason: "Ready", rank: "healthy", gitops: null, pods: [] };

function seed(items: WorkloadDTO[]) {
  useFleet.setState((s) => ({ workloads: { ...s.workloads, cluster: "homelab-nelli", items, namespaces: ["monitoring", "ollama-prod"], loading: false } }));
}

describe("WorkloadsView", () => {
  beforeEach(() => useFleet.getState().clearWorkloads());

  it("renders triage rows with reason, restarts, and gitops owner", () => {
    seed([broken, healthy]);
    const { getByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(getByText("CrashLoopBackOff")).toBeTruthy();
    expect(getByText("flux ks/ollama")).toBeTruthy();
    expect(getByText("0 / 1")).toBeTruthy();
  });

  it("expands a row to show its pods", () => {
    seed([broken]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    expect(queryByText("ollama-x")).toBeNull();
    fireEvent.click(getByText("ollama"));
    expect(getByText("ollama-x")).toBeTruthy();
    expect(getByText("node-3")).toBeTruthy();
  });

  it("needs-attention filter hides healthy rows", () => {
    seed([broken, healthy]);
    const { getByText, queryByText } = render(<WorkloadsView cluster="homelab-nelli" />);
    fireEvent.click(getByText(/needs attention/i));
    expect(getByText("ollama")).toBeTruthy();
    expect(queryByText("grafana")).toBeNull();
  });
});
```

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/WorkloadsView.test.tsx`
Expected: FAIL (stub renders nothing).

- [ ] **Step 2: Implement the view**

Replace `cmd/klyx/frontend/src/cluster/WorkloadsView.tsx`:

```tsx
import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import type { WorkloadDTO, PodDTO, WorkloadKind } from "../store/fleet";
import { listWorkloads } from "../bridge/workloads";

const rankDot: Record<string, string> = {
  unhealthy: "var(--color-text-danger)",
  degraded: "var(--color-text-warning)",
  restarts: "var(--color-text-info)",
  healthy: "var(--color-text-tertiary)",
};
const KINDS: WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet"];
const kindShort: Record<WorkloadKind, string> = { Deployment: "deploy", StatefulSet: "sts", DaemonSet: "daemonset" };
const keyOf = (w: WorkloadDTO) => `${w.kind}/${w.namespace}/${w.name}`;
function ago(s: number): string { return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`; }

export function WorkloadsView({ cluster }: { cluster: string }) {
  const wl = useFleet((s) => s.workloads);
  useEffect(() => {
    listWorkloads(cluster, "");
    return () => useFleet.getState().clearWorkloads();
  }, [cluster]);

  const rows = wl.items.filter((w) => wl.kindFilter[w.kind as WorkloadKind] && (!wl.needsAttention || w.rank !== "healthy"));

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={wl.namespace} onChange={(e) => listWorkloads(cluster, e.target.value)}
          style={{ fontSize: 12, padding: "3px 6px", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4 }}>
          <option value="">all namespaces</option>
          {wl.namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        {KINDS.map((k) => (
          <Chip key={k} on={wl.kindFilter[k]} onClick={() => useFleet.getState().toggleWorkloadKind(k)}>{kindShort[k]}</Chip>
        ))}
        <Chip on={wl.needsAttention} onClick={() => useFleet.getState().toggleNeedsAttention()}>needs attention</Chip>
        <button onClick={() => listWorkloads(cluster, wl.namespace)} style={btn}>refresh</button>
      </div>

      {wl.loading && wl.items.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading workloads…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No workloads{wl.namespace ? ` in ${wl.namespace}` : ""}.</div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {rows.map((w) => {
            const expanded = wl.expanded.includes(keyOf(w));
            return (
              <div key={keyOf(w)}>
                <div onClick={() => useFleet.getState().toggleWorkloadExpand(keyOf(w))}
                  style={{ display: "grid", gridTemplateColumns: "12px 90px 1fr 70px 64px 1.2fr 160px", gap: 10, alignItems: "center", padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: rankDot[w.rank] }} />
                  <span style={{ color: "var(--color-text-tertiary)" }}>{kindShort[w.kind as WorkloadKind]}</span>
                  <span><span style={{ color: "var(--color-text-tertiary)" }}>{w.namespace}</span> / <span style={{ fontWeight: 500 }}>{w.name}</span></span>
                  <span style={{ color: w.ready < w.desired ? "var(--color-text-warning)" : "var(--color-text-secondary)" }}>{w.ready} / {w.desired}</span>
                  <span style={{ color: w.restarts > 0 ? "var(--color-text-warning)" : "var(--color-text-tertiary)" }}>{w.restarts}</span>
                  <span style={{ color: w.rank === "unhealthy" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>{w.reason}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }} title={w.gitops ? `Flux ownership label: ${w.gitops.kind} ${w.gitops.namespace}/${w.gitops.name}` : undefined}>
                    {w.gitops ? `flux ${w.gitops.kind === "HelmRelease" ? "hr" : "ks"}/${w.gitops.name}` : "—"}
                  </span>
                </div>
                {expanded && <PodTable pods={w.pods} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PodTable({ pods }: { pods: PodDTO[] }) {
  if (pods.length === 0) return <div style={{ padding: "6px 8px 10px 32px", color: "var(--color-text-tertiary)", fontSize: 11 }}>no pods</div>;
  return (
    <div style={{ padding: "4px 8px 8px 32px", background: "var(--color-background-secondary)" }}>
      {pods.map((p) => (
        <div key={p.name} style={{ display: "grid", gridTemplateColumns: "1fr 60px 56px 1fr 120px 50px", gap: 10, fontSize: 11, padding: "3px 0", color: "var(--color-text-secondary)" }}>
          <span>{p.name}</span>
          <span style={{ color: p.ready ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{p.ready ? "ready" : "not ready"}</span>
          <span>{p.restarts}</span>
          <span style={{ color: p.reason ? "var(--color-text-danger)" : "var(--color-text-tertiary)" }}>{p.reason || "—"}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>{p.node}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>{ago(p.ageSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 11, cursor: "pointer",
      border: on ? "0.5px solid var(--color-text-info)" : "0.5px solid var(--color-border-tertiary)",
      background: on ? "var(--color-background-info, transparent)" : "transparent",
      color: on ? "var(--color-text-info)" : "var(--color-text-tertiary)" }}>{children}</button>
  );
}

const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };
```

- [ ] **Step 3: Run the view test + full vitest**

Run: `cd cmd/klyx/frontend && npx vitest run`
Expected: PASS (new WorkloadsView cases + all existing). If a `getByText` collides, tighten the matcher.

- [ ] **Step 4: Bindings + typecheck + full gate**

```bash
cd cmd/klyx && wails3 generate bindings && cd frontend && npx tsc --noEmit
```
Expected: bindings include `WorkloadsService.ListWorkloads`; `tsc --noEmit` clean.

From the repo root:
```bash
make test && go test -race ./internal/... && make vet
```
Then:
```bash
cd cmd/klyx && wails3 build
```
Expected: all PASS; `wails3 build` exit 0. (Ignore the pre-existing `cmd/klyx/build/ios` artifact. Do NOT git-add generated `bindings/`.)

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/WorkloadsView.tsx cmd/klyx/frontend/src/cluster/WorkloadsView.test.tsx
git commit -m "feat(ui): Workloads triage list with inline pod expand"
```

---

## Native verification (homelab-nelli) — after Task 7

The cluster is healthy, so deploy deliberate failures in a `klyx-test` namespace, then clean up:

1. **Bad image** → `kubectl -n klyx-test create deploy badimg --image=does-not-exist:nope`. Open the Workloads view → `badimg` row is red, `0/1 · ImagePullBackOff`, **floated to the top**; click it → the failing pod with its node + age. Confirms reason extraction, rank, sort, inline expand.
2. **Scaled to zero** → `kubectl -n klyx-test scale deploy/badimg --replicas=0`. Row shows `0/0 · Scaled to 0`, muted/healthy, **not red**. Confirms the false-alarm guard.
3. A **Flux-managed** workload (`monitoring/grafana`) shows `flux ks/<name>` with the tooltip `Flux ownership label: …`; a non-Flux workload shows `—`.
4. **Namespace filter** to `monitoring` re-fetches scoped; dropdown still lists all namespaces.
5. **Cleanup:** `kubectl delete ns klyx-test`.

---

## Self-review notes (author)

- **Spec coverage:** model + per-kind classify incl. condition priority (T1); worst-pod-reason precedence + severity incl. pod phase/OOMKilled (T2); Assemble join (empty-selector→none), rank, scaled-to-zero-first reason, owner, sort, AgeSeconds-from-now (T3); fleet ListWorkloads namespace-at-source + Flux-gated owner (T4); appbridge DTOs + namespaces-only-on-all-load + pinned rank strings (T5); nav + slice + namespace-preservation + fallback + bridge stale-guard (T6); triage rows + pod expand + needs-attention + owner tooltip + empty state + full gate (T7).
- **Type consistency:** `workloads.Workload`/`Pod`/`Owner`/`HealthRank` flow workloads→fleet→appbridge unchanged; DTO json tags match the store TS types; `ListWorkloads(ctx, namespace)` identical in fleet impl, `Conn`, and `appbridge.WorkloadsConn`; rank strings lowercase end to end.
- **Known ripple:** T4 adds `ListWorkloads` to `Conn` (fakeConn stub swept in-task); T6 commits green via a `WorkloadsView` stub fleshed out in T7.
- **Deferred (no task, by design):** cpu/mem metrics (M7-c-ii-b); logs/events (diagnosis milestone); Argo ownership; namespace-grouped sort mode; restart aging.
