package flux

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestResolveGitLink(t *testing.T) {
	cases := []struct {
		name              string
		remote, path, rev string
		wantURL           string
		wantDeep          bool
	}{
		{"gitlab https", "https://gitlab.com/org/repo.git", "./apps/x", "main@sha1:abc", "https://gitlab.com/org/repo/-/tree/main/apps/x", true},
		{"gitlab scp ssh", "git@gitlab.com:org/repo.git", "clusters/homelab", "main@sha1:abc", "https://gitlab.com/org/repo/-/tree/main/clusters/homelab", true},
		{"github https no path", "https://github.com/org/repo", "", "v1.2.3", "https://github.com/org/repo/tree/v1.2.3", true},
		{"flux refs/heads revision", "https://gitlab.com/org/repo.git", "helm-apps/x", "refs/heads/main@sha1:abc", "https://gitlab.com/org/repo/-/tree/main/helm-apps/x", true},
		{"flux refs/tags revision", "https://github.com/org/repo.git", "apps", "refs/tags/v1.2.3@sha1:abc", "https://github.com/org/repo/tree/v1.2.3/apps", true},
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
			"path":      "./clusters/homelab",
			"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"},
		},
		"status": map[string]interface{}{"lastAppliedRevision": "main@sha1:abc"},
	}}
	s := ParseKustomizationSource(u)
	if s.SourceKind != "GitRepository" || s.SourceName != "flux-system" {
		t.Fatalf("sourceRef: %+v", s)
	}
	if s.SourceNamespace != "flux-system" {
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
