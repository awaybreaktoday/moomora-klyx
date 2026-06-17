package appbridge

import (
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/moomora/klyx/internal/gitops/flux"
)

func TestToSourceDTO(t *testing.T) {
	dto := toSourceDTO(flux.Source{
		Kind: flux.GitRepositoryKind, Namespace: "flux-system", Name: "apps",
		Ready: flux.Failed, Reason: "GitOperationFailed", Revision: "main@sha1:abc", URL: "https://x/y",
	})
	if dto.Kind != "GitRepository" || dto.Ready != "Failed" || dto.Reason != "GitOperationFailed" {
		t.Fatalf("dto: %+v", dto)
	}
	if dto.Revision != "main@sha1:abc" || dto.URL != "https://x/y" {
		t.Fatalf("dto fields: %+v", dto)
	}
}

func TestGetResourceDetailEmbedsBoundSource(t *testing.T) {
	ks := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]interface{}{"name": "apps", "namespace": "flux-system"},
		"spec":     map[string]interface{}{"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "flux-system"}},
		"status":   map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "False", "reason": "BuildFailed"}}},
	}}
	src := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "source.toolkit.fluxcd.io/v1", "kind": "GitRepository",
		"metadata": map[string]interface{}{"name": "flux-system", "namespace": "flux-system"},
		"status":   map[string]interface{}{"artifact": map[string]interface{}{"revision": "main@sha1:def"}, "conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}}},
	}}
	conn := &fakeGitOpsConn{obj: ks, srcObj: src}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)

	dto := svc.GetResourceDetail("x", "Kustomization", "flux-system", "apps")
	if dto.Source == nil {
		t.Fatal("expected an embedded bound source")
	}
	if dto.Source.Kind != "GitRepository" || dto.Source.Revision != "main@sha1:def" || dto.Source.Ready != "Ready" {
		t.Fatalf("embedded source: %+v", dto.Source)
	}
}

func TestGetResourceDetailNoBoundSource(t *testing.T) {
	// A resource with no sourceRef and no source object: Source stays nil.
	hr := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
		"metadata": map[string]interface{}{"name": "x", "namespace": "y"},
		"spec":     map[string]interface{}{},
	}}
	conn := &fakeGitOpsConn{obj: hr}
	svc := NewGitOpsService(func(string) (GitOpsConn, bool) { return conn, true }, &fakeEmitter{}, time.Now, time.Second)
	if dto := svc.GetResourceDetail("x", "HelmRelease", "y", "x"); dto.Source != nil {
		t.Fatalf("expected nil source, got %+v", dto.Source)
	}
}
