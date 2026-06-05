# M4-c: CRD Instance Detail (YAML) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-page per-instance detail reached by clicking a row in the M4-b instance list: header + generic `status.conditions` strip + describe-style Events + full object YAML (read-only, copy, refresh).

**Architecture:** One bound `GetInstanceDetail` does a dynamic `Get` of the one object (→ YAML via `sigs.k8s.io/yaml`, parse conditions, header) plus a typed `Events` list filtered by `involvedObject.uid`, returned as one DTO. The cluster route gains an optional `instance` ref; `InstanceDetail` renders when `resource` + `instance` are both set. Snapshot, no watch.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic fake + typed fake for events) + `sigs.k8s.io/yaml`, Wails v3 bound services, React 19 + TS 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **Two cheap reads:** `c.dyn.Resource(gvr).Namespace(ns).Get` (namespaced) or `c.dyn.Resource(gvr).Get` (cluster-scoped, `ns==""`) for the object; `c.typed.CoreV1().Events("").List(...)` for events. Both clients are already on `ClusterConn`.
- **Events:** core `corev1.Event` has `Type`/`Reason`/`Message`/`Count int32`/`LastTimestamp metav1.Time`/`EventTime metav1.MicroTime`/`InvolvedObject corev1.ObjectReference`. Filter with `FieldSelector: "involvedObject.uid=<uid>"`, `Limit: 50`. The fake clientset does NOT enforce field selectors, so tests seed only the matching event and assert mapping/sort; the selector is a passthrough.
- **YAML:** `sigs.k8s.io/yaml` is currently an indirect dep; importing it promotes it to direct (run `go mod tidy`). `yaml.Marshal(u.Object)` produces kubectl-style YAML from the unstructured map.
- **Reuse:** `appbridge.ConditionDTO{Type,Status,Reason,Message}` already exists (GitOps detail). The frontend `ConditionDTO` type already exists in the store.
- **Route is already drill-aware:** `setSection`/`openResource`/`closeResource` rebuild fresh route literals (they already drop a stale `instance`). Only `openInstance` keeps `resource` and adds `instance`; `closeInstance` keeps `resource` and drops `instance`.
- **Wire points:** the InstanceList row is `InstanceList.tsx:64`; `ClusterDetail.tsx:27-29` forks the resources section; `Breadcrumb.tsx:24-39` renders the section/resource crumbs.
- **Copy feedback:** add a tiny `copyText` bridge fn (`Clipboard.SetText`) and a local "Copied" flag in the view, so the test mocks the bridge, not the runtime.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/crd/detail.go` | `Condition`, `Event`, `InstanceDetail`, `ParseConditions`, `ToYAML` | Create |
| `internal/crd/detail_test.go` | parse + yaml tests | Create |
| `internal/fleet/crd.go` | `ClusterConn.GetInstanceDetail` | Modify |
| `internal/fleet/crd_test.go` | dynamic+typed fake detail test | Modify |
| `internal/fleet/conn.go` | `Conn` interface += GetInstanceDetail | Modify |
| `internal/fleet/registry_test.go` | `fakeConn` stub | Modify |
| `internal/appbridge/crd_dto.go` | `EventDTO` + `InstanceDetailDTO` | Modify |
| `internal/appbridge/crd_service.go` | `CRDConn` += GetInstanceDetail; method | Modify |
| `internal/appbridge/crd_service_test.go` | fake stub + mapping test | Modify |
| `cmd/klyx/frontend/src/store/fleet.ts` | route.instance, openInstance/closeInstance, instanceDetail slice | Modify |
| `cmd/klyx/frontend/src/store/fleet.test.ts` | store action tests | Modify |
| `cmd/klyx/frontend/src/bridge/crd.ts` | `getInstanceDetail` + `copyText` | Modify |
| `cmd/klyx/frontend/src/cluster/InstanceDetail.tsx` | the view | Create |
| `cmd/klyx/frontend/src/cluster/InstanceDetail.test.tsx` | view tests | Create |
| `cmd/klyx/frontend/src/cluster/InstanceList.tsx` | row -> openInstance | Modify |
| `cmd/klyx/frontend/src/cluster/InstanceList.test.tsx` | row-click test | Modify |
| `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx` | instance -> InstanceDetail | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` | name crumb + back | Modify |
| `cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx` | name-crumb test (append) | Modify |

---

## Task 1: `internal/crd` detail pieces

**Files:**
- Create: `internal/crd/detail.go`, `internal/crd/detail_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/crd/detail_test.go`:

```go
package crd

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestParseConditions(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True", "reason": "OK", "message": "all good"},
				map[string]interface{}{"type": "Synced", "status": "False", "reason": "Err", "message": "boom"},
			},
		},
	}}
	cs := ParseConditions(u.Object)
	if len(cs) != 2 {
		t.Fatalf("want 2 conditions, got %d", len(cs))
	}
	if cs[0].Type != "Ready" || cs[0].Status != "True" || cs[0].Message != "all good" {
		t.Fatalf("cond[0]: %+v", cs[0])
	}
	if cs[1].Status != "False" || cs[1].Reason != "Err" {
		t.Fatalf("cond[1]: %+v", cs[1])
	}
}

func TestParseConditionsNoneWhenAbsent(t *testing.T) {
	if cs := ParseConditions(map[string]interface{}{}); len(cs) != 0 {
		t.Fatalf("want 0, got %d", len(cs))
	}
}

func TestToYAML(t *testing.T) {
	obj := map[string]interface{}{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Certificate",
		"metadata":   map[string]interface{}{"name": "web-tls", "namespace": "default"},
	}
	y, err := ToYAML(obj)
	if err != nil {
		t.Fatalf("ToYAML: %v", err)
	}
	if !strings.Contains(y, "kind: Certificate") || !strings.Contains(y, "name: web-tls") {
		t.Fatalf("yaml missing fields:\n%s", y)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/crd/ -run 'TestParseConditions|TestToYAML' -v`
Expected: FAIL - `ParseConditions`/`ToYAML` undefined.

- [ ] **Step 3: Implement `internal/crd/detail.go`**

```go
package crd

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

// Condition is one status.conditions entry.
type Condition struct {
	Type    string
	Status  string
	Reason  string
	Message string
}

// Event is a describe-style event for an instance.
type Event struct {
	Type    string // Normal | Warning
	Reason  string
	Message string
	Count   int32
	Last    time.Time
}

// InstanceDetail is the full per-instance detail: header, conditions, events, YAML.
type InstanceDetail struct {
	Kind       string
	Namespace  string
	Name       string
	Created    time.Time
	Labels     map[string]string
	Conditions []Condition
	Events     []Event
	YAML       string
}

// ParseConditions maps status.conditions[] (a near-universal convention). Empty
// when the field is absent or not a list of objects.
func ParseConditions(obj map[string]interface{}) []Condition {
	raw, _, _ := unstructured.NestedSlice(obj, "status", "conditions")
	out := make([]Condition, 0, len(raw))
	for _, c := range raw {
		m, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cond := Condition{}
		cond.Type, _ = m["type"].(string)
		cond.Status, _ = m["status"].(string)
		cond.Reason, _ = m["reason"].(string)
		cond.Message, _ = m["message"].(string)
		out = append(out, cond)
	}
	return out
}

// ToYAML marshals an unstructured Object map to kubectl-style YAML.
func ToYAML(obj map[string]interface{}) (string, error) {
	b, err := yaml.Marshal(obj)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
```

- [ ] **Step 4: Run + tidy**

Run: `go test ./internal/crd/ -run 'TestParseConditions|TestToYAML' -v` then `cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx && go mod tidy && go test ./internal/crd/`.
Expected: PASS; `go mod tidy` promotes `sigs.k8s.io/yaml` to a direct dependency.

- [ ] **Step 5: Commit**

```bash
git add internal/crd/detail.go internal/crd/detail_test.go go.mod go.sum
git commit -m "feat(crd): instance detail pieces - Condition/Event/InstanceDetail + ParseConditions + ToYAML"
```

---

## Task 2: `ClusterConn.GetInstanceDetail`

**Files:**
- Modify: `internal/fleet/crd.go`
- Test: `internal/fleet/crd_test.go`
- Modify: `internal/fleet/conn.go` (`Conn` interface), `internal/fleet/registry_test.go` (`fakeConn`)

- [ ] **Step 1: Write the failing test**

Add to `internal/fleet/crd_test.go`. It already imports `context`, `metav1`, `unstructured`, `schema`, `dynamicfake`, `clock`, `crd`. Add `corev1 "k8s.io/api/core/v1"` and `typedfake "k8s.io/client-go/kubernetes/fake"` to the imports.

```go
func TestGetInstanceDetail(t *testing.T) {
	wGVR := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{wGVR: "WidgetList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata":   map[string]interface{}{"name": "w1", "namespace": "team-a", "uid": "uid-1", "labels": map[string]interface{}{"app": "w"}},
		"status":     map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True", "reason": "OK", "message": "ready"}}},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)

	ev := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "w1.evt", Namespace: "team-a"},
		InvolvedObject: corev1.ObjectReference{Kind: "Widget", Name: "w1", Namespace: "team-a", UID: "uid-1"},
		Type:           "Warning", Reason: "Failed", Message: "could not reconcile", Count: 3,
		LastTimestamp:  metav1.Now(),
	}
	typed := typedfake.NewSimpleClientset(ev)

	c := NewClusterConn("x", typed, nil, dyn, nil, clock.Real{})

	d, err := c.GetInstanceDetail(context.Background(), "example.com", "v1", "widgets", "team-a", "w1")
	if err != nil {
		t.Fatalf("detail: %v", err)
	}
	if d.Kind != "Widget" || d.Name != "w1" || d.Namespace != "team-a" {
		t.Fatalf("header: %+v", d)
	}
	if len(d.Conditions) != 1 || d.Conditions[0].Type != "Ready" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if len(d.Events) != 1 || d.Events[0].Type != "Warning" || d.Events[0].Count != 3 {
		t.Fatalf("events: %+v", d.Events)
	}
	if !strings.Contains(d.YAML, "kind: Widget") {
		t.Fatalf("yaml: %s", d.YAML)
	}
	if d.Labels["app"] != "w" {
		t.Fatalf("labels: %+v", d.Labels)
	}
}

func TestGetInstanceDetailClusterScoped(t *testing.T) {
	nGVR := schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumnodes"}
	scheme := dynScheme()
	listKinds := map[schema.GroupVersionResource]string{nGVR: "CiliumNodeList"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "cilium.io/v2",
		"kind":       "CiliumNode",
		"metadata":   map[string]interface{}{"name": "node-1", "uid": "uid-n1"}, // no namespace
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, obj)
	c := NewClusterConn("x", typedfake.NewSimpleClientset(), nil, dyn, nil, clock.Real{})

	d, err := c.GetInstanceDetail(context.Background(), "cilium.io", "v2", "ciliumnodes", "", "node-1")
	if err != nil {
		t.Fatalf("cluster-scoped detail: %v", err)
	}
	if d.Kind != "CiliumNode" || d.Namespace != "" || !strings.Contains(d.YAML, "kind: CiliumNode") {
		t.Fatalf("cluster-scoped: %+v", d)
	}
}
```

(Add `"strings"` to the test imports if not present.)

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestGetInstanceDetail -v`
Expected: FAIL - `c.GetInstanceDetail undefined`.

- [ ] **Step 3: Implement in `internal/fleet/crd.go`**

Add the imports `corev1 "k8s.io/api/core/v1"`, `"sort"`, and `"k8s.io/apimachinery/pkg/fields"` to `internal/fleet/crd.go` (it already imports `context`, `metav1`, `unstructured`, `schema`, `crd`). Then:

```go
// GetInstanceDetail fetches one object (full YAML + conditions + header) plus its
// describe-style Events (filtered by involvedObject.uid). Snapshot; no watch.
func (c *ClusterConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	var (
		u   *unstructured.Unstructured
		err error
	)
	if ns == "" {
		u, err = c.dyn.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
	} else {
		u, err = c.dyn.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		return crd.InstanceDetail{}, err
	}

	yaml, _ := crd.ToYAML(u.Object)
	d := crd.InstanceDetail{
		Kind:       u.GetKind(),
		Namespace:  ns,
		Name:       name,
		Created:    u.GetCreationTimestamp().Time,
		Labels:     u.GetLabels(),
		Conditions: crd.ParseConditions(u.Object),
		YAML:       yaml,
	}
	d.Events = c.instanceEvents(ctx, string(u.GetUID()))
	return d, nil
}

// instanceEvents lists core Events for an object's uid, newest first. A list
// error degrades to no events (the detail still renders).
func (c *ClusterConn) instanceEvents(ctx context.Context, uid string) []crd.Event {
	if uid == "" {
		return nil
	}
	sel := fields.OneTermEqualSelector("involvedObject.uid", uid).String()
	list, err := c.typed.CoreV1().Events("").List(ctx, metav1.ListOptions{FieldSelector: sel, Limit: 50})
	if err != nil || list == nil {
		return nil
	}
	out := make([]crd.Event, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		last := e.LastTimestamp.Time
		if last.IsZero() {
			last = e.EventTime.Time
		}
		out = append(out, crd.Event{Type: e.Type, Reason: e.Reason, Message: e.Message, Count: e.Count, Last: last})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Last.After(out[b].Last) })
	return out
}
```

- [ ] **Step 4: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add (after `ListInstances`):

```go
	GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error)
```

- [ ] **Step 5: Add the `fakeConn` stub**

In `internal/fleet/registry_test.go`, after the `ListInstances` stub:

```go
func (f *fakeConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	return crd.InstanceDetail{}, nil
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestGetInstanceDetail|Registry' -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`.
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/crd.go internal/fleet/crd_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.GetInstanceDetail - object YAML + conditions + events"
```

---

## Task 3: appbridge `CRDService.GetInstanceDetail`

**Files:**
- Modify: `internal/appbridge/crd_dto.go` (DTOs)
- Modify: `internal/appbridge/crd_service.go` (`CRDConn` + method)
- Test: `internal/appbridge/crd_service_test.go`

- [ ] **Step 1: Write the failing test**

In `internal/appbridge/crd_service_test.go`:

(a) Add a field to `fakeCRDConn`:
```go
	detail crd.InstanceDetail
```
(b) Add the stub method:
```go
func (f *fakeCRDConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	return f.detail, nil
}
```
(c) Add the test:
```go
func TestGetInstanceDetailMapsDTO(t *testing.T) {
	created := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	last := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	conn := &fakeCRDConn{detail: crd.InstanceDetail{
		Kind: "Widget", Namespace: "team-a", Name: "w1", Created: created,
		Labels:     map[string]string{"app": "w"},
		Conditions: []crd.Condition{{Type: "Ready", Status: "True", Reason: "OK", Message: "ready"}},
		Events:     []crd.Event{{Type: "Warning", Reason: "Failed", Message: "boom", Count: 2, Last: last}},
		YAML:       "kind: Widget\n",
	}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	d := svc.GetInstanceDetail("x", "example.com", "v1", "widgets", "team-a", "w1")
	if d.Kind != "Widget" || d.Created != "2026-06-01T09:00:00Z" {
		t.Fatalf("header: %+v", d)
	}
	if len(d.Conditions) != 1 || d.Conditions[0].Type != "Ready" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if len(d.Events) != 1 || d.Events[0].Count != 2 || d.Events[0].LastSeen != "2026-06-02T10:00:00Z" {
		t.Fatalf("events: %+v", d.Events)
	}
	if d.YAML != "kind: Widget\n" || d.Labels["app"] != "w" {
		t.Fatalf("yaml/labels: %+v", d)
	}
}

func TestGetInstanceDetailUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if d := svc.GetInstanceDetail("ghost", "g", "v", "p", "n", "x"); d.Kind != "" || len(d.Conditions) != 0 {
		t.Fatalf("want empty, got %+v", d)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestGetInstanceDetail -v`
Expected: FAIL - `svc.GetInstanceDetail` undefined; `fakeCRDConn` does not satisfy the widened `CRDConn`.

- [ ] **Step 3: Add DTOs to `internal/appbridge/crd_dto.go`**

```go
// EventDTO is a describe-style event.
type EventDTO struct {
	Type     string `json:"type"`     // Normal | Warning
	Reason   string `json:"reason"`
	Message  string `json:"message"`
	Count    int    `json:"count"`
	LastSeen string `json:"lastSeen"` // RFC3339; "" when unset
}

// InstanceDetailDTO is the full per-instance detail.
type InstanceDetailDTO struct {
	Kind       string            `json:"kind"`
	Namespace  string            `json:"namespace"`
	Name       string            `json:"name"`
	Created    string            `json:"created"` // RFC3339; "" when unset
	Labels     map[string]string `json:"labels"`
	Conditions []ConditionDTO    `json:"conditions"`
	Events     []EventDTO        `json:"events"`
	YAML       string            `json:"yaml"`
}
```

- [ ] **Step 4: Extend `CRDConn` + add the method**

In `internal/appbridge/crd_service.go`, add to the `CRDConn` interface (after `ListInstances`):

```go
	GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error)
```

Add the bound method (a small RFC3339 helper keeps it tidy):

```go
func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

// GetInstanceDetail returns the full per-instance detail. Zero value on miss/error.
func (s *CRDService) GetInstanceDetail(cluster, group, version, plural, namespace, name string) InstanceDetailDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return InstanceDetailDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), crdTimeout)
	defer cancel()
	d, err := conn.GetInstanceDetail(ctx, group, version, plural, namespace, name)
	if err != nil {
		return InstanceDetailDTO{}
	}
	labels := d.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	conds := make([]ConditionDTO, 0, len(d.Conditions))
	for _, c := range d.Conditions {
		conds = append(conds, ConditionDTO{Type: c.Type, Status: c.Status, Reason: c.Reason, Message: c.Message})
	}
	events := make([]EventDTO, 0, len(d.Events))
	for _, e := range d.Events {
		events = append(events, EventDTO{Type: e.Type, Reason: e.Reason, Message: e.Message, Count: int(e.Count), LastSeen: rfc3339(e.Last)})
	}
	return InstanceDetailDTO{
		Kind: d.Kind, Namespace: d.Namespace, Name: d.Name,
		Created: rfc3339(d.Created), Labels: labels,
		Conditions: conds, Events: events, YAML: d.YAML,
	}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -run TestGetInstanceDetail -v` then `go test ./internal/appbridge/` and `go vet ./internal/appbridge/`.
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/crd_dto.go internal/appbridge/crd_service.go internal/appbridge/crd_service_test.go
git commit -m "feat(appbridge): CRDService.GetInstanceDetail - InstanceDetailDTO"
```

---

## Task 4: Store - route instance + detail slice + bridge

**Files:**
- Modify: `cmd/klyx/frontend/src/store/fleet.ts`
- Test: `cmd/klyx/frontend/src/store/fleet.test.ts`
- Modify: `cmd/klyx/frontend/src/bridge/crd.ts`

- [ ] **Step 1: Write the failing store test**

Add to `cmd/klyx/frontend/src/store/fleet.test.ts`:

```ts
import { useFleet as uf3 } from "./fleet";

test("instance detail drill-in route + slice", () => {
  uf3.getState().openCluster("x");
  const ref = { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" };
  uf3.getState().openResource(ref);
  uf3.getState().openInstance("default", "web-tls");
  const r = uf3.getState().route;
  expect(r).toMatchObject({ name: "cluster", section: "resources", resource: { kind: "Certificate" }, instance: { namespace: "default", name: "web-tls" } });
  expect(uf3.getState().instanceDetail.ref).toEqual({ namespace: "default", name: "web-tls" });
  expect(uf3.getState().instanceDetail.loading).toBe(true);

  uf3.getState().setInstanceDetail({ kind: "Certificate", namespace: "default", name: "web-tls", created: "", labels: {}, conditions: [], events: [], yaml: "kind: Certificate\n" });
  expect(uf3.getState().instanceDetail.detail?.yaml).toContain("Certificate");
  expect(uf3.getState().instanceDetail.loading).toBe(false);

  // closeInstance keeps the resource, drops the instance.
  uf3.getState().closeInstance();
  const r2 = uf3.getState().route;
  expect(r2.name === "cluster" && r2.resource?.kind).toBe("Certificate");
  expect(r2.name === "cluster" && r2.instance).toBeUndefined();

  // openResource drops a prior instance; setSection drops both.
  uf3.getState().openInstance("default", "web-tls");
  uf3.getState().openResource(ref);
  expect(uf3.getState().route.name === "cluster" && uf3.getState().route.instance).toBeUndefined();
  uf3.getState().openInstance("default", "web-tls");
  uf3.getState().setSection("gitops");
  const r3 = uf3.getState().route;
  expect(r3.name === "cluster" && r3.resource).toBeUndefined();
  expect(r3.name === "cluster" && r3.instance).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts -t "instance detail drill-in"`
Expected: FAIL - `openInstance is not a function`.

- [ ] **Step 3: Implement in `src/store/fleet.ts`**

(a) Add types near `ResourceRef`/`InstanceDTO`:
```ts
export type InstanceRef = { namespace: string; name: string };
export type EventDTO = { type: string; reason: string; message: string; count: number; lastSeen: string };
export type InstanceDetailDTO = { kind: string; namespace: string; name: string; created: string; labels: Record<string, string>; conditions: ConditionDTO[]; events: EventDTO[]; yaml: string };
export type InstanceDetailSlice = { ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean };
```
(`ConditionDTO` is already exported in this file.)

(b) Extend the `Route` cluster variant with `instance`:
```ts
  | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef; instance?: InstanceRef };
```

(c) Add to the `FleetState` type:
```ts
  openInstance: (namespace: string, name: string) => void;
  closeInstance: () => void;
  instanceDetail: InstanceDetailSlice;
  setInstanceDetailLoading: (ref: InstanceRef) => void;
  setInstanceDetail: (d: InstanceDetailDTO) => void;
  clearInstanceDetail: () => void;
```

(d) Add to the store body (place after the `instances` actions):
```ts
  openInstance: (namespace, name) =>
    set((s) =>
      s.route.name === "cluster" && s.route.resource
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "resources", resource: s.route.resource, instance: { namespace, name } },
            instanceDetail: { ref: { namespace, name }, detail: null, loading: true },
          }
        : {}),
  closeInstance: () =>
    set((s) =>
      s.route.name === "cluster"
        ? { route: { name: "cluster", cluster: s.route.cluster, section: s.route.section, resource: s.route.resource } }
        : {}),
  instanceDetail: { ref: null, detail: null, loading: false },
  setInstanceDetailLoading: (ref) => set({ instanceDetail: { ref, detail: null, loading: true } }),
  setInstanceDetail: (detail) => set((s) => ({ instanceDetail: { ...s.instanceDetail, detail, loading: false } })),
  clearInstanceDetail: () => set({ instanceDetail: { ref: null, detail: null, loading: false } }),
```

NOTE: `openResource` and `setSection` already rebuild fresh route literals (they do not spread `...s.route`), so they already drop a stale `instance` - no change needed there. Verify by reading those actions; if either spreads `...s.route`, change it to an explicit literal without `instance`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/store/fleet.test.ts`
Expected: all PASS.

- [ ] **Step 5: Add bridge functions to `src/bridge/crd.ts`**

Extend the store import to add `InstanceRef` and `InstanceDetailDTO`; add a `@wailsio/runtime` import for `Clipboard`:
```ts
import { Clipboard } from "@wailsio/runtime";
```
(and add `InstanceRef, InstanceDetailDTO` to the existing `from "../store/fleet"` import).

Append:
```ts
export async function getInstanceDetail(cluster: string, resource: ResourceRef, instance: InstanceRef): Promise<void> {
  useFleet.getState().setInstanceDetailLoading(instance);
  const d = (await CRDService.GetInstanceDetail(cluster, resource.group, resource.version, resource.plural, instance.namespace, instance.name)) as InstanceDetailDTO;
  // Drop a stale detail if the user navigated to a different instance meanwhile.
  const cur = useFleet.getState().instanceDetail.ref;
  if (!cur || cur.namespace !== instance.namespace || cur.name !== instance.name) return;
  useFleet.getState().setInstanceDetail(d);
}

export async function copyText(text: string): Promise<void> {
  await Clipboard.SetText(text);
}
```

NOTE: `CRDService.GetInstanceDetail` resolves only after bindings are regenerated (Task 7). Do NOT run tsc/build here; vitest mocks the bridge.

- [ ] **Step 6: Commit**

```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts cmd/klyx/frontend/src/bridge/crd.ts
git commit -m "feat(ui): route instance ref + instanceDetail slice + getInstanceDetail/copyText bridge"
```

---

## Task 5: `InstanceDetail` view

**Files:**
- Create: `cmd/klyx/frontend/src/cluster/InstanceDetail.tsx`, `cmd/klyx/frontend/src/cluster/InstanceDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `cmd/klyx/frontend/src/cluster/InstanceDetail.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceRef, InstanceDetailDTO } from "../store/fleet";
import { InstanceDetail } from "./InstanceDetail";

vi.mock("../bridge/crd", () => ({ getInstanceDetail: vi.fn(async () => {}), copyText: vi.fn(async () => {}) }));
import { getInstanceDetail, copyText } from "../bridge/crd";

const resource: ResourceRef = { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" };
const instance: InstanceRef = { namespace: "default", name: "web-tls" };
const detail: InstanceDetailDTO = {
  kind: "Certificate", namespace: "default", name: "web-tls", created: "", labels: { app: "web" },
  conditions: [{ type: "Ready", status: "True", reason: "Issued", message: "Certificate is up to date" }],
  events: [{ type: "Warning", reason: "Failed", message: "order failed", count: 2, lastSeen: "" }],
  yaml: "apiVersion: cert-manager.io/v1\nkind: Certificate\n",
};

function seed(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}) {
  useFleet.setState({ instanceDetail: { ref: instance, detail, loading: false, ...over } });
}

beforeEach(() => { vi.clearAllMocks(); seed(); });

describe("InstanceDetail", () => {
  it("renders header, conditions, events, and YAML", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText("Certificate")).toBeTruthy();
    expect(getByText("Ready")).toBeTruthy();
    expect(getByText(/Certificate is up to date/)).toBeTruthy();
    expect(getByText(/order failed/)).toBeTruthy();
    expect(getByText(/kind: Certificate/)).toBeTruthy();
  });

  it("copy calls the bridge with the YAML", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/copy/i));
    expect(copyText).toHaveBeenCalledWith(detail.yaml);
  });

  it("refresh re-fetches", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/refresh/i));
    expect(getInstanceDetail).toHaveBeenCalledWith("x", resource, instance);
  });

  it("shows a no-events note when there are none", () => {
    seed({ detail: { ...detail, events: [] } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText(/no events/i)).toBeTruthy();
  });

  it("shows a loading state before the detail arrives", () => {
    seed({ detail: null, loading: true });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText(/Loading/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceDetail.test.tsx`
Expected: FAIL - cannot find module `./InstanceDetail`.

- [ ] **Step 3: Implement `src/cluster/InstanceDetail.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useFleet, ResourceRef, InstanceRef } from "../store/fleet";
import { getInstanceDetail, copyText } from "../bridge/crd";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function age(created: string): string {
  if (!created) return "";
  const ms = Date.now() - Date.parse(created);
  if (Number.isNaN(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const condColor = (status: string) =>
  status === "True" ? "var(--color-text-success)" : status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)";

export function InstanceDetail({ cluster, resource, instance }: { cluster: string; resource: ResourceRef; instance: InstanceRef }) {
  const id = useFleet((s) => s.instanceDetail);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getInstanceDetail(cluster, resource, instance);
    return () => useFleet.getState().clearInstanceDetail();
  }, [cluster, resource.group, resource.version, resource.plural, instance.namespace, instance.name]);

  const isCurrent = id.ref && id.ref.namespace === instance.namespace && id.ref.name === instance.name;
  const d = isCurrent ? id.detail : null;

  const onCopy = () => {
    if (!d) return;
    void copyText(d.yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{resource.kind}</div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {instance.namespace ? `${instance.namespace}/` : ""}{instance.name}
        </span>
        {d && d.created && <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{age(d.created)}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => void getInstanceDetail(cluster, resource, instance)} style={btn}>Refresh</button>
      </div>

      {id.loading && !d ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading detail…</div>
      ) : !d ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Could not load this instance.</div>
      ) : (
        <>
          {Object.keys(d.labels).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {Object.entries(d.labels).map(([k, v]) => (
                <span key={k} style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 10, padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>{k}={v}</span>
              ))}
            </div>
          )}

          {d.conditions.length > 0 && (
            <Section title="Conditions">
              {d.conditions.map((c) => (
                <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c.status), display: "inline-block" }} />
                  <span style={{ fontWeight: 500, width: 90 }}>{c.type}</span>
                  <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
                </div>
              ))}
            </Section>
          )}

          <Section title={`Events (${d.events.length})`}>
            {d.events.length === 0 ? (
              <span style={{ color: "var(--color-text-tertiary)" }}>No events for this object.</span>
            ) : (
              d.events.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", color: e.type === "Warning" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
                  <span style={{ width: 56, fontSize: 10, textTransform: "uppercase" }}>{e.type}</span>
                  <span style={{ fontWeight: 500, width: 120, ...ellipsis }}>{e.reason}</span>
                  <span style={{ ...ellipsis }} title={e.message}>{e.message}</span>
                  {e.count > 1 && <span style={{ color: "var(--color-text-tertiary)" }}>×{e.count}</span>}
                  <span style={{ color: "var(--color-text-tertiary)" }}>{age(e.lastSeen)}</span>
                </div>
              ))
            )}
          </Section>

          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>YAML</div>
              <div style={{ flex: 1 }} />
              <button onClick={onCopy} style={btn}>{copied ? "Copied" : "Copy"}</button>
            </div>
            <pre style={{ margin: 0, padding: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: "60vh", color: "var(--color-text-primary)" }}>{d.yaml}</pre>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>{children}</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)",
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceDetail.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/InstanceDetail.tsx cmd/klyx/frontend/src/cluster/InstanceDetail.test.tsx
git commit -m "feat(ui): InstanceDetail - header, conditions, events, YAML + copy/refresh"
```

---

## Task 6: Wiring - row click, ClusterDetail, Breadcrumb

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/InstanceList.tsx` + `InstanceList.test.tsx`
- Modify: `cmd/klyx/frontend/src/cluster/ClusterDetail.tsx`
- Modify: `cmd/klyx/frontend/src/chrome/Breadcrumb.tsx` + `Breadcrumb.test.tsx`

- [ ] **Step 1: Write the failing tests**

(a) Add to `cmd/klyx/frontend/src/cluster/InstanceList.test.tsx` (inside the existing `describe`; `fireEvent` is already imported):

```tsx
it("clicking a row opens the instance detail", () => {
  useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource: nsRef } });
  seed(nsRef);
  const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
  fireEvent.click(getByText("coredns-abc"));
  const r = useFleet.getState().route;
  expect(r.name === "cluster" && r.instance).toEqual({ namespace: "kube-system", name: "coredns-abc" });
});
```

(b) Append to `cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx` (inside the existing `describe`):

```tsx
  it("shows the instance name crumb when an instance is selected", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource: { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" }, instance: { namespace: "default", name: "web-tls" } } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("web-tls")).toBeTruthy();
    expect(getByText("Certificate")).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceList.test.tsx src/chrome/Breadcrumb.test.tsx`
Expected: FAIL - row click does not set `instance`; breadcrumb has no name crumb.

- [ ] **Step 3: Make InstanceList rows clickable**

In `cmd/klyx/frontend/src/cluster/InstanceList.tsx`, add the action selector near the top of the component (next to `const setFilter = useFleet((s) => s.setInstanceFilter);`):
```tsx
  const openInstance = useFleet((s) => s.openInstance);
```
Change the row `<div key={`${r.namespace}/${r.name}`} ...>` (currently `InstanceList.tsx:64`) to add `onClick` + `cursor: "pointer"`:
```tsx
            <div
              key={`${r.namespace}/${r.name}`}
              onClick={() => openInstance(r.namespace, r.name)}
              style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, cursor: "pointer" }}
            >
```
(Leave the inner cells unchanged.)

- [ ] **Step 4: Wire `ClusterDetail.tsx`**

Add the import:
```tsx
import { InstanceDetail } from "./InstanceDetail";
```
Change the `resources` branch (currently renders `route.resource ? <InstanceList/> : <CRDBrowser/>`) to a three-way fork:
```tsx
  if (route.section === "resources") {
    if (route.resource && route.instance) return <InstanceDetail cluster={cluster.name} resource={route.resource} instance={route.instance} />;
    if (route.resource) return <InstanceList cluster={cluster.name} resource={route.resource} />;
    return <CRDBrowser cluster={cluster.name} />;
  }
```

- [ ] **Step 5: Wire `Breadcrumb.tsx`**

Add `closeInstance` to the selectors (next to `closeResource`):
```tsx
  const closeInstance = useFleet((s) => s.closeInstance);
```
In the section block, the kind crumb is currently a plain `<span>`. Change it so that when an instance is selected the kind crumb becomes a back button, and append the instance name. Replace the `{route.resource && (...)}` block (currently `Breadcrumb.tsx:32-37`) with:
```tsx
          {route.resource && (
            <>
              <span>/</span>
              {route.instance ? (
                <button onClick={closeInstance} style={{ ...crumbBtn, fontFamily: "var(--font-mono)" }}>{route.resource.kind}</button>
              ) : (
                <span style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>{route.resource.kind}</span>
              )}
            </>
          )}
          {route.resource && route.instance && (
            <>
              <span>/</span>
              <span style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>{route.instance.name}</span>
            </>
          )}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/InstanceList.test.tsx src/chrome/Breadcrumb.test.tsx` then `npx vitest run` (whole suite green).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/InstanceList.tsx cmd/klyx/frontend/src/cluster/InstanceList.test.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx
git commit -m "feat(ui): drill from instance row into InstanceDetail - click, route, breadcrumb"
```

---

## Task 7: Regenerate bindings, full build, verification

- [ ] **Step 1: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, race + vet clean.

- [ ] **Step 2: Regenerate bindings + frontend suite + full native build**

```bash
cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
grep -rn "GetInstanceDetail" frontend/bindings/github.com/moomora/klyx/internal/appbridge/ | head
cd frontend && npx vitest run && npx tsc --noEmit
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: bindings show `GetInstanceDetail`; vitest all green; `tsc` clean; `wails3 build` exit 0.

- [ ] **Step 3: Native handoff (manual, owner)**

On `homelab-nelli`: Resources → a kind → click an instance → confirm the detail page shows header, conditions, events, and YAML; the **Copy** button copies the YAML; **Refresh** re-fetches; the breadcrumb shows `… / <Kind> / <name>` and the `<Kind>` crumb returns to the list. Drill a cluster-scoped kind (`CiliumNode`) and confirm the detail renders without a namespace and the YAML is complete.

- [ ] **Step 4: Commit any build-surfaced fixes** (skip if none)

```bash
git add -A && git commit -m "chore(m4-c): verification fixes"
```

---

## Self-review notes

- **Spec coverage:** §2 data → Tasks 1-2. §3 appbridge → Task 3. §4 route + slice + bridge → Task 4. §5 view → Task 5. §5.3 wiring → Task 6. §6 testing → each task + Task 7 native.
- **No watch / snapshot:** `GetInstanceDetail` is two one-shot reads; the view clears the detail on unmount (`clearInstanceDetail`) and refresh re-fetches. Consistent with M4.
- **Stale-detail guard:** `getInstanceDetail` re-checks `instanceDetail.ref` after the await; the view also guards via `isCurrent`. A late detail from a previous instance cannot render.
- **Events degrade:** an Events-list error returns `nil` events (Task 2 `instanceEvents`), so YAML/conditions still render.
- **Route drop-through:** `openResource`/`setSection` already rebuild fresh literals (drop `instance`); `closeResource` drops both; `openInstance` keeps `resource` + adds `instance`; `closeInstance` keeps `resource`, drops `instance`. Task 4 verifies and only adds `openInstance`/`closeInstance`.
- **Known correction baked in:** Task 5 flags that `InstanceRef` has no `kind`; the view uses `resource.kind`.
- **Type consistency:** `crd.InstanceDetail`/`Condition`/`Event` (Go) → `InstanceDetailDTO`/`ConditionDTO`/`EventDTO` (Go appbridge json) → TS types. `GetInstanceDetail(ctx, group, version, plural, ns, name)` identical on `Conn`, `CRDConn`, `ClusterConn`, both fakes. `ConditionDTO` reused (not redefined).
- **Binding timing:** `bridge/crd.ts` references `CRDService.GetInstanceDetail` before Task 7 regenerates bindings; vitest mocks the bridge, so unit tests pass; full `tsc`/build is Task 7.
