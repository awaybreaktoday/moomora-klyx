# M3-c-ii: View-in-Git Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "View in Git" action to the GitOps detail panel for Kustomizations that resolves the Flux `GitRepository` source to a browsable GitLab/GitHub deep link (open in browser), falling back to copying a `repo path@revision` reference for unknown hosts.

**Architecture:** Pure URL resolver + source-ref parser in `internal/gitops/flux`; an on-demand `GitRepository` fetch via the dynamic client on `ClusterConn` (no new informer); a Wails-bound `GitOpsService.ResolveGitLink` that orchestrates store-read → parse → fetch → resolve and returns a `GitLinkDTO`; the frontend opens the URL via `@wailsio/runtime` `Browser.OpenURL` or copies via `Clipboard.SetText`. This is the second plan under the M3-c spec (`docs/superpowers/specs/2026-06-04-klyx-gitops-actions-design.md` §5); M3-c-i (writes) already shipped to main.

**Tech Stack:** Go 1.26 + client-go v0.36 (dynamic fake), Wails v3 bound services + `@wailsio/runtime` Browser/Clipboard, React 19 + TS 6 + Zustand 5 + Vitest 4.

---

## Context the engineer needs

- **What "view in git" means:** a Flux `Kustomization` has `spec.sourceRef` (kind `GitRepository`, a name, optional namespace) and a `spec.path`. The referenced `GitRepository` has `spec.url` (an HTTPS or SSH git remote). The Kustomization's `status.lastAppliedRevision` is `branch@sha1:...`. We turn `(remote, path, revision)` into a web URL: GitLab uses `/-/tree/<ref>/<path>`, GitHub uses `/tree/<ref>/<path>`.
- **On-demand, not watched:** the `GitRepository` is NOT in any informer (we only watch Kustomizations + HelmReleases). `ClusterConn` fetches it with a one-off dynamic `Get` when the user clicks. The Kustomization itself comes from the already-running watch store via the existing `GitOpsObject(kind, ns, name)`.
- **Existing reusable pieces:**
  - `ClusterConn` has `dyn dynamic.Interface`, `typed kubernetes.Interface`; `preferredVersion(disc, group, fallback)` resolves served GVR versions (fallback used in tests).
  - `GitOpsObject(kind, namespace, name) (*unstructured.Unstructured, bool)` reads the watch store (on `Conn` + `GitOpsConn`).
  - `internal/fleet/gitopsactions_test.go` already has package-level test helpers `newActionConn(dyn)`, `dynScheme()`, and the import pattern for the dynamic fake. Reuse them from a new `_test.go` in the same `fleet` package.
  - appbridge `GitOpsService` has `s.lookup(cluster) (GitOpsConn, bool)` and `const actionTimeout = 30 * time.Second`.
  - The store action-status toast (`setActionStatus`) from M3-c-i is reused for view-in-git feedback.
- **Kustomization only:** HelmRelease chart sources are out of scope (documented in the spec). The button only renders for Kustomization rows.

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `internal/gitops/flux/gitlink.go` | Pure `ResolveGitLink` + `ParseKustomizationSource` | Create |
| `internal/gitops/flux/gitlink_test.go` | Fixture tests for both | Create |
| `internal/fleet/gitopssource.go` | `ClusterConn.SourceURL` (dynamic Get) | Create |
| `internal/fleet/gitopssource_test.go` | Dynamic-fake fetch tests | Create |
| `internal/fleet/conn.go` | Add `SourceURL` to `Conn` interface | Modify |
| `internal/fleet/registry_test.go` | `fakeConn` stub | Modify |
| `internal/appbridge/gitops_dto.go` | `GitLinkDTO` | Modify |
| `internal/appbridge/gitops_service.go` | `GitOpsConn.SourceURL` + `ResolveGitLink` | Modify |
| `internal/appbridge/gitops_service_test.go` | fake stub + tests | Modify |
| `cmd/klyx/frontend/src/bridge/gitops.ts` | `resolveGitLink` (open/copy) | Modify |
| `cmd/klyx/frontend/src/cluster/GitOps.tsx` | "View in Git" button (Kustomization only) | Modify |
| `cmd/klyx/frontend/src/cluster/GitOps.test.tsx` | button interaction tests | Modify |

---

## Task 1: Pure `ResolveGitLink` + `ParseKustomizationSource`

**Files:**
- Create: `internal/gitops/flux/gitlink.go`
- Test: `internal/gitops/flux/gitlink_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/gitops/flux/gitlink_test.go`:

```go
package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestResolveGitLink(t *testing.T) {
	cases := []struct {
		name             string
		remote, path, rev string
		wantURL          string
		wantDeep         bool
	}{
		{"gitlab https", "https://gitlab.com/org/repo.git", "./apps/x", "main@sha1:abc", "https://gitlab.com/org/repo/-/tree/main/apps/x", true},
		{"gitlab scp ssh", "git@gitlab.com:org/repo.git", "clusters/homelab", "main@sha1:abc", "https://gitlab.com/org/repo/-/tree/main/clusters/homelab", true},
		{"github https no path", "https://github.com/org/repo", "", "v1.2.3", "https://github.com/org/repo/tree/v1.2.3", true},
		{"self-hosted gitlab with port", "ssh://git@gitlab.example.com:2222/org/repo.git", "a", "main@sha1:x", "https://gitlab.example.com/org/repo/-/tree/main/a", true},
		{"unknown host falls back to copy", "https://git.example.com/org/repo.git", "apps", "main@sha1:abc", "", false},
		{"empty remote", "", "apps", "main", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveGitLink(tc.remote, tc.path, tc.rev)
			if got.IsDeepLink != tc.wantDeep {
				t.Fatalf("IsDeepLink: want %v got %v (%+v)", tc.wantDeep, got.IsDeepLink, got)
			}
			if tc.wantDeep && got.URL != tc.wantURL {
				t.Fatalf("URL: want %q got %q", tc.wantURL, got.URL)
			}
			if !tc.wantDeep && got.CopyText == "" && tc.remote != "" {
				t.Fatalf("expected non-empty CopyText for fallback, got %+v", got)
			}
		})
	}
}

func TestResolveGitLinkCopyTextShape(t *testing.T) {
	got := ResolveGitLink("https://git.example.com/org/repo.git", "./apps/x", "main@sha1:abc")
	want := "https://git.example.com/org/repo.git apps/x@main@sha1:abc"
	if got.CopyText != want {
		t.Fatalf("want %q got %q", want, got.CopyText)
	}
}

func TestParseKustomizationSource(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "app", "namespace": "flux-system"},
		"spec": map[string]interface{}{
			"path": "./clusters/homelab",
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"},
		},
		"status": map[string]interface{}{"lastAppliedRevision": "main@sha1:abc"},
	}}
	s := ParseKustomizationSource(u)
	if s.SourceKind != "GitRepository" || s.SourceName != "flux-system" {
		t.Fatalf("sourceRef: %+v", s)
	}
	if s.SourceNamespace != "flux-system" { // defaults to the object namespace
		t.Fatalf("want default namespace flux-system, got %q", s.SourceNamespace)
	}
	if s.Path != "./clusters/homelab" || s.Revision != "main@sha1:abc" {
		t.Fatalf("path/rev: %+v", s)
	}
}

func TestParseKustomizationSourceExplicitNamespace(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "app", "namespace": "apps"},
		"spec": map[string]interface{}{
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "src", "namespace": "flux-system"},
		},
	}}
	if s := ParseKustomizationSource(u); s.SourceNamespace != "flux-system" {
		t.Fatalf("want explicit namespace flux-system, got %q", s.SourceNamespace)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/gitops/flux/ -run 'ResolveGitLink|ParseKustomizationSource' -v`
Expected: FAIL - `undefined: ResolveGitLink` / `undefined: ParseKustomizationSource`.

- [ ] **Step 3: Implement**

Create `internal/gitops/flux/gitlink.go`:

```go
package flux

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// GitLink is a resolved navigation target for a Flux source. IsDeepLink is true
// when URL is a browsable web URL (GitLab/GitHub); otherwise CopyText holds a
// "<remote> <path>@<revision>" reference for the clipboard.
type GitLink struct {
	URL        string `json:"url"`
	IsDeepLink bool   `json:"isDeepLink"`
	CopyText   string `json:"copyText"`
}

// ResolveGitLink turns a GitRepository remote + a Kustomization path + applied
// revision into a browsable web URL for known hosts, degrading to a copyable
// reference for unrecognised hosts or unparseable remotes.
func ResolveGitLink(remote, path, revision string) GitLink {
	copyText := strings.TrimSpace(remote)
	if cp := cleanPath(path); cp != "" {
		copyText += " " + cp
	}
	if revision != "" {
		copyText += "@" + revision
	}

	host, repoPath, ok := normalizeRemote(remote)
	if !ok {
		return GitLink{IsDeepLink: false, CopyText: copyText}
	}
	ref := refFromRevision(revision)

	var url string
	switch {
	case strings.Contains(host, "gitlab"):
		url = "https://" + host + "/" + repoPath + "/-/tree/" + ref
	case strings.Contains(host, "github"):
		url = "https://" + host + "/" + repoPath + "/tree/" + ref
	default:
		return GitLink{IsDeepLink: false, CopyText: copyText}
	}
	if p := cleanPath(path); p != "" {
		url += "/" + p
	}
	return GitLink{URL: url, IsDeepLink: true, CopyText: copyText}
}

func refFromRevision(rev string) string {
	if rev == "" {
		return "HEAD"
	}
	if i := strings.Index(rev, "@"); i >= 0 {
		return rev[:i]
	}
	return rev
}

func cleanPath(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "./")
	return strings.Trim(p, "/")
}

// normalizeRemote extracts (host, "org/repo") from https/ssh/scp git remotes,
// stripping any scheme, userinfo, port, and a trailing ".git".
func normalizeRemote(remote string) (host, repoPath string, ok bool) {
	r := strings.TrimSpace(remote)
	if r == "" {
		return "", "", false
	}
	r = strings.TrimSuffix(r, ".git")

	if strings.Contains(r, "://") {
		// scheme://[user@]host[:port]/org/repo
		r = r[strings.Index(r, "://")+3:]
		if at := strings.Index(r, "@"); at >= 0 {
			r = r[at+1:]
		}
		slash := strings.Index(r, "/")
		if slash < 0 {
			return "", "", false
		}
		host, repoPath = r[:slash], strings.Trim(r[slash+1:], "/")
		if c := strings.Index(host, ":"); c >= 0 { // strip port
			host = host[:c]
		}
	} else {
		// scp-style: [user@]host:org/repo
		if at := strings.Index(r, "@"); at >= 0 {
			r = r[at+1:]
		}
		colon := strings.Index(r, ":")
		if colon < 0 {
			return "", "", false
		}
		host, repoPath = r[:colon], strings.Trim(r[colon+1:], "/")
	}
	if host == "" || repoPath == "" {
		return "", "", false
	}
	return host, repoPath, true
}

// KustomizationSource is the source pointer + path + applied revision needed to
// build a Git link. SourceNamespace defaults to the Kustomization's namespace.
type KustomizationSource struct {
	SourceKind      string
	SourceName      string
	SourceNamespace string
	Path            string
	Revision        string
}

// ParseKustomizationSource extracts the source pointer, path, and applied
// revision from a Kustomization unstructured. Pure.
func ParseKustomizationSource(u *unstructured.Unstructured) KustomizationSource {
	var s KustomizationSource
	s.SourceKind, _, _ = unstructured.NestedString(u.Object, "spec", "sourceRef", "kind")
	s.SourceName, _, _ = unstructured.NestedString(u.Object, "spec", "sourceRef", "name")
	s.SourceNamespace, _, _ = unstructured.NestedString(u.Object, "spec", "sourceRef", "namespace")
	if s.SourceNamespace == "" {
		s.SourceNamespace = u.GetNamespace()
	}
	s.Path, _, _ = unstructured.NestedString(u.Object, "spec", "path")
	s.Revision, _, _ = unstructured.NestedString(u.Object, "status", "lastAppliedRevision")
	return s
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/gitops/flux/ -run 'ResolveGitLink|ParseKustomizationSource' -v` then `go test ./internal/gitops/flux/`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/gitops/flux/gitlink.go internal/gitops/flux/gitlink_test.go
git commit -m "feat(flux): pure ResolveGitLink + ParseKustomizationSource"
```

---

## Task 2: `ClusterConn.SourceURL` (on-demand GitRepository fetch)

**Files:**
- Create: `internal/fleet/gitopssource.go`
- Test: `internal/fleet/gitopssource_test.go`
- Modify: `internal/fleet/conn.go` (the `Conn` interface)
- Modify: `internal/fleet/registry_test.go` (`fakeConn` stub)

- [ ] **Step 1: Write the failing test**

Create `internal/fleet/gitopssource_test.go` (reuses `newActionConn` and `dynScheme` from `gitopsactions_test.go`, same package):

```go
package fleet

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

func gitRepoGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "source.toolkit.fluxcd.io", Version: "v1", Resource: "gitrepositories"}
}

func seedGitRepo(name, url string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1",
		"kind":       "GitRepository",
		"metadata":   map[string]interface{}{"name": name, "namespace": "flux-system"},
		"spec":       map[string]interface{}{"url": url},
	}}
}

func TestSourceURLReturnsSpecURL(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{gitRepoGVR(): "GitRepositoryList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds, seedGitRepo("flux-system", "https://gitlab.com/org/repo.git"))
	c := newActionConn(dyn)

	url, ok := c.SourceURL(context.Background(), "GitRepository", "flux-system", "flux-system")
	if !ok || url != "https://gitlab.com/org/repo.git" {
		t.Fatalf("want the seeded url, got %q ok=%v", url, ok)
	}
}

func TestSourceURLUnknownKind(t *testing.T) {
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), map[schema.GroupVersionResource]string{})
	c := newActionConn(dyn)
	if _, ok := c.SourceURL(context.Background(), "OCIRepository", "flux-system", "x"); ok {
		t.Fatal("unsupported source kind must return ok=false")
	}
}

func TestSourceURLNotFound(t *testing.T) {
	listKinds := map[schema.GroupVersionResource]string{gitRepoGVR(): "GitRepositoryList"}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(dynScheme(), listKinds)
	c := newActionConn(dyn)
	if _, ok := c.SourceURL(context.Background(), "GitRepository", "flux-system", "missing"); ok {
		t.Fatal("missing object must return ok=false")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/fleet/ -run TestSourceURL -v`
Expected: FAIL - `c.SourceURL undefined`.

- [ ] **Step 3: Implement**

Create `internal/fleet/gitopssource.go`:

```go
package fleet

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// sourceGVR maps a Flux source kind to its group, fallback version, and resource.
// Only GitRepository is supported; OCIRepository/Bucket are future work.
func sourceGVR(kind string) (group, fallbackVersion, resource string, ok bool) {
	switch kind {
	case "GitRepository":
		return "source.toolkit.fluxcd.io", "v1", "gitrepositories", true
	default:
		return "", "", "", false
	}
}

// SourceURL fetches spec.url from a Flux source object via a one-off dynamic Get
// (the source is not watched). Returns ok=false for an unsupported kind, a Get
// error, or an empty url.
func (c *ClusterConn) SourceURL(ctx context.Context, kind, ns, name string) (string, bool) {
	group, fallback, resource, ok := sourceGVR(kind)
	if !ok {
		return "", false
	}
	version := preferredVersion(c.typed.Discovery(), group, fallback)
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: resource}
	u, err := c.dyn.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", false
	}
	url, _, _ := unstructured.NestedString(u.Object, "spec", "url")
	if url == "" {
		return "", false
	}
	return url, true
}
```

- [ ] **Step 4: Add to the `Conn` interface**

In `internal/fleet/conn.go`, add to the `Conn` interface (after the `SetSuspend` line added in M3-c-i):

```go
	SourceURL(ctx context.Context, kind, ns, name string) (string, bool)
```

- [ ] **Step 5: Add the `fakeConn` stub**

In `internal/fleet/registry_test.go`, after the `SetSuspend` stub:

```go
func (f *fakeConn) SourceURL(ctx context.Context, kind, ns, name string) (string, bool) {
	return "", false
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `go test ./internal/fleet/ -run 'TestSourceURL|Registry' -v` then `go test ./internal/fleet/` and `go vet ./internal/fleet/`.
Expected: PASS, vet clean.

- [ ] **Step 7: Commit**

```bash
git add internal/fleet/gitopssource.go internal/fleet/gitopssource_test.go internal/fleet/conn.go internal/fleet/registry_test.go
git commit -m "feat(fleet): ClusterConn.SourceURL fetches a Flux source spec.url"
```

---

## Task 3: appbridge `GitLinkDTO` + `GitOpsService.ResolveGitLink`

**Files:**
- Modify: `internal/appbridge/gitops_dto.go` (add `GitLinkDTO`)
- Modify: `internal/appbridge/gitops_service.go` (`GitOpsConn.SourceURL` + `ResolveGitLink`)
- Modify: `internal/appbridge/gitops_service_test.go` (fake stub + tests)

- [ ] **Step 1: Write the failing test**

In `internal/appbridge/gitops_service_test.go`:

(a) Add a field to `fakeGitOpsConn`:
```go
	sourceURL string
```
(b) Add the stub methods (the struct already has `obj *unstructured.Unstructured` returned by `GitOpsObject`):
```go
func (f *fakeGitOpsConn) SourceURL(ctx context.Context, kind, ns, name string) (string, bool) {
	if f.sourceURL == "" {
		return "", false
	}
	return f.sourceURL, true
}
```
(c) Add the tests:
```go
func TestResolveGitLinkDeepLink(t *testing.T) {
	ks := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "app", "namespace": "flux-system"},
		"kind":     "Kustomization",
		"spec": map[string]interface{}{
			"path":      "./apps/x",
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"},
		},
		"status": map[string]interface{}{"lastAppliedRevision": "main@sha1:abc"},
	}}
	conn := &fakeGitOpsConn{obj: ks, sourceURL: "https://gitlab.com/org/repo.git"}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)

	link := svc.ResolveGitLink("x", "Kustomization", "flux-system", "app")
	if !link.IsDeepLink || link.URL != "https://gitlab.com/org/repo/-/tree/main/apps/x" {
		t.Fatalf("deep link: %+v", link)
	}
}

func TestResolveGitLinkNonKustomizationIsEmpty(t *testing.T) {
	conn := &fakeGitOpsConn{}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	if link := svc.ResolveGitLink("x", "HelmRelease", "ns", "app"); link.URL != "" || link.IsDeepLink {
		t.Fatalf("HelmRelease must be empty, got %+v", link)
	}
}

func TestResolveGitLinkNoSourceURLIsEmpty(t *testing.T) {
	ks := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "app", "namespace": "flux-system"},
		"spec":     map[string]interface{}{"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "src"}},
	}}
	conn := &fakeGitOpsConn{obj: ks} // sourceURL empty -> SourceURL returns ok=false
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	if link := svc.ResolveGitLink("x", "Kustomization", "flux-system", "app"); link.URL != "" || link.IsDeepLink {
		t.Fatalf("want empty link when source url missing, got %+v", link)
	}
}
```
Note: `fakeGitOpsConn.GitOpsObject` already returns `f.obj` (from M3-c-i). The `context` import is already present from M3-c-i.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/appbridge/ -run TestResolveGitLink -v`
Expected: FAIL - `svc.ResolveGitLink undefined`; `fakeGitOpsConn` does not satisfy the widened interface.

- [ ] **Step 3: Add `GitLinkDTO`**

In `internal/appbridge/gitops_dto.go`:
```go
// GitLinkDTO is a resolved Git navigation target for a Flux resource.
type GitLinkDTO struct {
	URL        string `json:"url"`
	IsDeepLink bool   `json:"isDeepLink"`
	CopyText   string `json:"copyText"`
}
```

- [ ] **Step 4: Extend `GitOpsConn` and add `ResolveGitLink`**

In `internal/appbridge/gitops_service.go`, add to the `GitOpsConn` interface (after `SetSuspend`):
```go
	SourceURL(ctx context.Context, kind, ns, name string) (string, bool)
```

Add the bound method (place near `GetResourceDetail`; `context`, `time`, and the `flux` import are already present):
```go
// ResolveGitLink resolves a Kustomization's GitRepository source to a browsable
// link (or a copyable reference). Zero-value DTO for non-Kustomizations, a
// non-GitRepository source, or any lookup miss.
func (s *GitOpsService) ResolveGitLink(cluster, kind, namespace, name string) GitLinkDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return GitLinkDTO{}
	}
	if flux.Kind(kind) != flux.KustomizationKind {
		return GitLinkDTO{}
	}
	u, ok := conn.GitOpsObject(kind, namespace, name)
	if !ok {
		return GitLinkDTO{}
	}
	src := flux.ParseKustomizationSource(u)
	if src.SourceKind != "GitRepository" || src.SourceName == "" {
		return GitLinkDTO{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	url, ok := conn.SourceURL(ctx, "GitRepository", src.SourceNamespace, src.SourceName)
	if !ok {
		return GitLinkDTO{}
	}
	link := flux.ResolveGitLink(url, src.Path, src.Revision)
	return GitLinkDTO{URL: link.URL, IsDeepLink: link.IsDeepLink, CopyText: link.CopyText}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./internal/appbridge/ -run TestResolveGitLink -v` then `go test ./internal/appbridge/` and `go vet ./internal/appbridge/`.
Expected: PASS, vet clean.

- [ ] **Step 6: Commit**

```bash
git add internal/appbridge/gitops_dto.go internal/appbridge/gitops_service.go internal/appbridge/gitops_service_test.go
git commit -m "feat(appbridge): GitOpsService.ResolveGitLink with GitLinkDTO"
```

---

## Task 4: Frontend bridge `resolveGitLink` (open or copy)

**Files:**
- Modify: `cmd/klyx/frontend/src/bridge/gitops.ts`

- [ ] **Step 1: Regenerate Wails bindings first**

The Go `GitOpsService.ResolveGitLink` exists (Task 3). Regenerate so the TS binding is present:
```bash
cd cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 generate bindings
```
Confirm: `grep -r ResolveGitLink frontend/bindings/github.com/moomora/klyx/internal/appbridge/` shows the function.

- [ ] **Step 2: Add the bridge function**

In `cmd/klyx/frontend/src/bridge/gitops.ts`, extend the `@wailsio/runtime` import to include `Browser` and `Clipboard`, and append the function:

```ts
import { Events, Browser, Clipboard } from "@wailsio/runtime";
```
```ts
type GitLinkDTO = { url: string; isDeepLink: boolean; copyText: string };

export async function resolveGitLink(cluster: string, kind: string, namespace: string, name: string): Promise<void> {
  const link = (await GitOpsService.ResolveGitLink(cluster, kind, namespace, name)) as GitLinkDTO;
  if (link.isDeepLink && link.url) {
    await Browser.OpenURL(link.url);
    useFleet.getState().setActionStatus({ kind: "success", message: `Opened ${link.url}` });
  } else if (link.copyText) {
    await Clipboard.SetText(link.copyText);
    useFleet.getState().setActionStatus({ kind: "success", message: "Copied source reference to clipboard" });
  } else {
    useFleet.getState().setActionStatus({ kind: "error", message: "No Git source to open for this resource" });
  }
}
```
(The existing `import { Events } from "@wailsio/runtime";` line becomes the combined import above - do not leave a duplicate `Events` import.)

- [ ] **Step 3: Typecheck**

Run `npx tsc --noEmit` (from `cmd/klyx/frontend`). Must be clean (exit 0). If `Browser`/`Clipboard` are not found on `@wailsio/runtime`, STOP and report (do not hand-edit node_modules).

- [ ] **Step 4: Commit**

```bash
git add cmd/klyx/frontend/src/bridge/gitops.ts
git commit -m "feat(ui): resolveGitLink bridge - open deep link or copy reference"
```

---

## Task 5: "View in Git" button in the GitOps detail panel

**Files:**
- Modify: `cmd/klyx/frontend/src/cluster/GitOps.tsx`
- Test: `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `cmd/klyx/frontend/src/cluster/GitOps.test.tsx`:

(a) Extend the `vi.mock("../bridge/gitops", ...)` factory to add `resolveGitLink: vi.fn()`, and import it:
```tsx
import { reconcile, setSuspend, resolveGitLink } from "../bridge/gitops";
```
```tsx
vi.mock("../bridge/gitops", () => ({
  openGitOps: async () => () => {},
  closeGitOps: async () => {},
  getResourceDetail: async () => {},
  reconcile: vi.fn(),
  setSuspend: vi.fn(),
  resolveGitLink: vi.fn(),
}));
```
(b) Add the tests (reuse the `expandedDetail` helper added in M3-c-i):
```tsx
it("view-in-git button calls resolveGitLink for a Kustomization", () => {
  useFleet.setState({ clusters: [cluster("Healthy")], gitops: expandedDetail() });
  const { getByText } = render(<GitOps cluster="x" />);
  fireEvent.click(getByText("View in Git"));
  expect(resolveGitLink).toHaveBeenCalledWith("x", "Kustomization", "flux-system", "flux-system");
});

it("hides view-in-git for a HelmRelease", () => {
  useFleet.setState({
    clusters: [cluster("Healthy")],
    gitops: {
      cluster: "x",
      resources: [res({ kind: "HelmRelease", namespace: "ns", name: "app" })],
      loading: false,
      expandedKey: "HelmRelease/ns/app",
      detail: { kind: "HelmRelease", namespace: "ns", name: "app", suspended: false, appliedRevision: "", attemptedRevision: "", applyFailed: false, conditions: [], inventory: [] },
    },
  });
  const { queryByText } = render(<GitOps cluster="x" />);
  expect(queryByText("View in Git")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/GitOps.test.tsx`
Expected: FAIL - no "View in Git" element.

- [ ] **Step 3: Implement**

In `cmd/klyx/frontend/src/cluster/GitOps.tsx`:

(a) Add `resolveGitLink` to the bridge import:
```tsx
import { openGitOps, closeGitOps, getResourceDetail, reconcile, setSuspend, resolveGitLink } from "../bridge/gitops";
```
(b) In the expanded-row render, pass an `onViewGit` callback to `DetailPanel` (alongside the existing `onReconcile`/`onToggleSuspend`):
```tsx
                    onViewGit={() => void resolveGitLink(cluster, r.kind, r.namespace, r.name)}
```
(c) Update `DetailPanel`'s signature to accept `onViewGit: () => void`, and add the button to the actions row, rendered only for Kustomizations (place after the Suspend/Resume button, before the suspended badge):
```tsx
        {resource.kind === "Kustomization" && (
          <button onClick={onViewGit} style={actionBtn}>View in Git</button>
        )}
```
The `DetailPanel` signature becomes:
```tsx
function DetailPanel({ resource, detail, onReconcile, onToggleSuspend, onViewGit }: {
  resource: FluxResourceDTO;
  detail: ResourceDetailDTO | null;
  onReconcile: () => void;
  onToggleSuspend: (suspended: boolean) => void;
  onViewGit: () => void;
}) {
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cmd/klyx/frontend && npx vitest run src/cluster/GitOps.test.tsx` then `npx tsc --noEmit`.
Expected: all GitOps tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add cmd/klyx/frontend/src/cluster/GitOps.tsx cmd/klyx/frontend/src/cluster/GitOps.test.tsx
git commit -m "feat(ui): View in Git action for Kustomizations in the GitOps panel"
```

---

## Task 6: Full verification + native handoff

- [ ] **Step 1: Go suite + race + vet**

```bash
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx
make test && go test -race ./internal/... && make vet
```
Expected: all PASS, race + vet clean.

- [ ] **Step 2: Frontend suite + full native build**

```bash
cd cmd/klyx/frontend && npx vitest run
cd /Users/markjoyeux/Developer/Personal/github/moomora-klyx/cmd/klyx && PATH="$HOME/go/bin:$PATH" wails3 build
```
Expected: vitest all green; `wails3 build` exit 0 (regenerates bindings as part of the build).

- [ ] **Step 3: Native handoff (manual, owner)**

On `homelab-nelli`: expand a Kustomization (e.g. `flux-system/infrastructure`) → click **View in Git** → confirm it opens the correct GitLab deep link at the resource's path and branch in the browser. For a source on an unrecognised host, confirm it copies the `repo path@revision` reference and the toast says so.

- [ ] **Step 4: Commit any build-surfaced fixes** (skip if none)

```bash
git add -A
git commit -m "chore(m3c-ii): verification fixes"
```

---

## Self-review notes

- **Spec coverage (§5 of the M3-c spec):** `ResolveGitLink` pure resolver with SSH→HTTPS rewrite + GitLab/GitHub deep links + copy fallback → Task 1. On-demand `GitRepository` fetch (no informer) → Task 2. appbridge orchestration (store-read → parse → fetch → resolve), Kustomization-only, zero DTO on miss → Task 3. Browser-open via `@wailsio/runtime`, copy fallback → Tasks 4-5. HelmRelease shows no button → Task 5.
- **Interface ripple:** `SourceURL` is added to BOTH the fleet `Conn` (Task 2: production `ClusterConn` + `fakeConn` stub) and the appbridge `GitOpsConn` (Task 3: `fakeGitOpsConn` stub). Same pattern as M3-c-i's `Reconcile`/`SetSuspend`.
- **Type consistency:** `GitLink{URL,IsDeepLink,CopyText}` (Go) ↔ `GitLinkDTO` (Go json `url`/`isDeepLink`/`copyText`) ↔ `GitLinkDTO` (TS bridge). `SourceURL(ctx,kind,ns,name)(string,bool)` identical on `Conn` and `GitOpsConn`. `resolveGitLink` bridge args `(cluster,kind,ns,name)` match the `onViewGit` call site and the mock assertion.
- **Binding timing:** Task 4 regenerates bindings before the bridge references `GitOpsService.ResolveGitLink`, keeping `tsc` green for Tasks 4-5 (same approach proven in M3-c-i).
- **No new informer:** `SourceURL` is a one-off dynamic Get bounded by `actionTimeout`; the Kustomization comes from the existing watch store via `GitOpsObject`. Consistent with Approach A.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; the `ResolveGitLink` edge cases (empty remote, unknown host, scp vs scheme, port, empty path) are all covered by Task 1 fixtures.
