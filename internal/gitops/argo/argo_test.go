package argo

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func app(spec, status map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Application",
		"metadata":   map[string]interface{}{"name": "demo", "namespace": "argocd"},
		"spec":       spec,
		"status":     status,
	}}
}

func TestParseHealthyApp(t *testing.T) {
	u := app(
		map[string]interface{}{
			"project": "default",
			"source": map[string]interface{}{
				"repoURL":        "https://gitlab.com/x/workloads.git",
				"path":           "apps/console/overlays/dev",
				"targetRevision": "main",
			},
			"destination": map[string]interface{}{"namespace": "console-dev", "server": "https://kubernetes.default.svc"},
			"syncPolicy":  map[string]interface{}{"automated": map[string]interface{}{}},
		},
		map[string]interface{}{
			"sync":   map[string]interface{}{"status": "Synced", "revision": "abc1234def"},
			"health": map[string]interface{}{"status": "Healthy"},
			"operationState": map[string]interface{}{
				"phase": "Succeeded", "message": "successfully synced",
			},
			"reconciledAt": "2026-06-11T11:21:48Z",
		},
	)
	a := Parse(u)
	if a.SyncStatus != "Synced" || a.HealthStatus != "Healthy" {
		t.Fatalf("status: %+v", a)
	}
	if a.Project != "default" || a.Path != "apps/console/overlays/dev" || a.TargetRevision != "main" {
		t.Fatalf("source: %+v", a)
	}
	if !a.AutoSync || a.DestNamespace != "console-dev" {
		t.Fatalf("policy/dest: %+v", a)
	}
	if a.OpPhase != "Succeeded" || a.ReconciledAt.IsZero() {
		t.Fatalf("op/reconciledAt: %+v", a)
	}
	if a.Broken() {
		t.Fatal("synced+healthy must not be broken")
	}
}

func TestParseAbsentStatusIsUnknownNeverHealthy(t *testing.T) {
	a := Parse(app(map[string]interface{}{}, map[string]interface{}{}))
	if a.SyncStatus != "Unknown" || a.HealthStatus != "Unknown" {
		t.Fatalf("absent status must read Unknown: %+v", a)
	}
	if !a.Broken() {
		t.Fatal("Unknown must count as needing attention")
	}
}

func TestBrokenSemantics(t *testing.T) {
	cases := []struct {
		sync, health string
		broken       bool
	}{
		{"Synced", "Healthy", false},
		{"Synced", "Progressing", false}, // transitional, not broken
		{"OutOfSync", "Healthy", true},
		{"Synced", "Degraded", true},
		{"Synced", "Missing", true},
		{"Synced", "Suspended", true},
	}
	for _, tc := range cases {
		a := App{SyncStatus: tc.sync, HealthStatus: tc.health}
		if a.Broken() != tc.broken {
			t.Errorf("%s/%s: broken=%v, want %v", tc.sync, tc.health, a.Broken(), tc.broken)
		}
	}
}

func TestParseMultiSource(t *testing.T) {
	u := app(map[string]interface{}{
		"sources": []interface{}{
			map[string]interface{}{"repoURL": "https://r1", "chart": "grafana", "targetRevision": "8.x"},
			map[string]interface{}{"repoURL": "https://r2", "path": "values"},
		},
	}, map[string]interface{}{})
	a := Parse(u)
	if a.RepoURL != "https://r1" || a.Chart != "grafana" || a.ExtraSources != 1 {
		t.Fatalf("multi-source: %+v", a)
	}
}

func TestPatches(t *testing.T) {
	if !strings.Contains(string(RefreshPatch()), "argocd.argoproj.io/refresh") {
		t.Fatal("refresh patch wrong")
	}
	s := string(SyncPatch("abc123"))
	if !strings.Contains(s, `"revision":"abc123"`) || !strings.Contains(s, `"username":"klyx"`) {
		t.Fatalf("sync patch wrong: %s", s)
	}
	if strings.Contains(s, "prune") {
		t.Fatal("sync patch must not set prune")
	}
	if !strings.Contains(string(SyncPatch("")), `"revision":"HEAD"`) {
		t.Fatal("empty revision must default to HEAD")
	}
}
