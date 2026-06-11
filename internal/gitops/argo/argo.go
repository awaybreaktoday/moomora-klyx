// Package argo parses Argo CD Application objects into a typed model, speaking
// Argo's own vocabulary (design principle 8): sync status is Synced/OutOfSync,
// health is Healthy/Progressing/Degraded/Suspended/Missing - never translated
// into Flux terms.
package argo

import (
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// AppGVR is the Application resource group-version-resource.
var AppGVR = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}

// Condition is one status condition (Argo uses type+message, no status field).
type Condition struct {
	Type    string
	Message string
}

// App is one Argo CD Application.
type App struct {
	Namespace      string
	Name           string
	Project        string
	SyncStatus     string // Synced | OutOfSync | Unknown ("" -> Unknown)
	HealthStatus   string // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
	Revision       string // status.sync.revision (deployed)
	RepoURL        string
	Path           string
	Chart          string // helm-source apps use chart instead of path
	TargetRevision string
	ExtraSources   int // multi-source apps: number of sources beyond the first
	DestNamespace  string
	DestServer     string
	AutoSync       bool // spec.syncPolicy.automated present
	OpPhase        string
	OpMessage      string
	Conditions     []Condition
	ReconciledAt   time.Time
	CreatedAt      time.Time
}

// Broken reports whether the app needs attention: not synced or unhealthy.
// Progressing is transitional, not broken.
func (a App) Broken() bool {
	if a.SyncStatus != "Synced" {
		return true
	}
	switch a.HealthStatus {
	case "Healthy", "Progressing":
		return false
	}
	return true
}

// Parse maps an Application unstructured into the model. Absent status fields
// become "Unknown", never fabricated healthy values.
func Parse(u *unstructured.Unstructured) App {
	a := App{
		Namespace: u.GetNamespace(),
		Name:      u.GetName(),
		CreatedAt: u.GetCreationTimestamp().Time,
	}
	a.Project, _, _ = unstructured.NestedString(u.Object, "spec", "project")

	// Source: single spec.source, or first of spec.sources for multi-source apps.
	src, found, _ := unstructured.NestedMap(u.Object, "spec", "source")
	if !found {
		if srcs, ok, _ := unstructured.NestedSlice(u.Object, "spec", "sources"); ok && len(srcs) > 0 {
			if first, ok := srcs[0].(map[string]interface{}); ok {
				src = first
				a.ExtraSources = len(srcs) - 1
			}
		}
	}
	if src != nil {
		a.RepoURL, _ = src["repoURL"].(string)
		a.Path, _ = src["path"].(string)
		a.Chart, _ = src["chart"].(string)
		a.TargetRevision, _ = src["targetRevision"].(string)
	}

	a.DestNamespace, _, _ = unstructured.NestedString(u.Object, "spec", "destination", "namespace")
	a.DestServer, _, _ = unstructured.NestedString(u.Object, "spec", "destination", "server")
	if _, ok, _ := unstructured.NestedMap(u.Object, "spec", "syncPolicy", "automated"); ok {
		a.AutoSync = true
	}

	a.SyncStatus, _, _ = unstructured.NestedString(u.Object, "status", "sync", "status")
	if a.SyncStatus == "" {
		a.SyncStatus = "Unknown"
	}
	a.Revision, _, _ = unstructured.NestedString(u.Object, "status", "sync", "revision")
	a.HealthStatus, _, _ = unstructured.NestedString(u.Object, "status", "health", "status")
	if a.HealthStatus == "" {
		a.HealthStatus = "Unknown"
	}
	a.OpPhase, _, _ = unstructured.NestedString(u.Object, "status", "operationState", "phase")
	a.OpMessage, _, _ = unstructured.NestedString(u.Object, "status", "operationState", "message")

	if conds, ok, _ := unstructured.NestedSlice(u.Object, "status", "conditions"); ok {
		for _, c := range conds {
			if m, ok := c.(map[string]interface{}); ok {
				t, _ := m["type"].(string)
				msg, _ := m["message"].(string)
				a.Conditions = append(a.Conditions, Condition{Type: t, Message: msg})
			}
		}
	}
	if ts, ok, _ := unstructured.NestedString(u.Object, "status", "reconciledAt"); ok && ts != "" {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			a.ReconciledAt = t
		}
	}
	return a
}

// RefreshPatch is the merge patch that asks the controller to re-compare the
// app against its source - Argo's equivalent of a flux reconcile annotation.
func RefreshPatch() []byte {
	return []byte(`{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"normal"}}}`)
}

// SyncPatch is the merge patch that starts a sync operation. Setting the
// .operation field is the documented headless trigger (the argocd CLI's API
// server route ends in the same field); the controller picks it up. Prune is
// deliberately NOT set - prune stays an explicit human decision in Argo's UI
// or CLI.
func SyncPatch(revision string) []byte {
	if revision == "" {
		revision = "HEAD"
	}
	return []byte(fmt.Sprintf(
		`{"operation":{"initiatedBy":{"username":"klyx"},"sync":{"revision":%q}}}`, revision))
}
