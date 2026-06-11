package appbridge

import (
	"context"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/moomora/klyx/internal/gitops/argo"
)

const argoTimeout = 30 * time.Second

// ArgoConn is the per-cluster surface ArgoService needs (lookup seam).
type ArgoConn interface {
	ListArgoApps(ctx context.Context) ([]argo.App, error)
	RefreshArgoApp(ctx context.Context, namespace, name string) error
	SyncArgoApp(ctx context.Context, namespace, name, revision string) error
}

// ArgoConditionDTO is one Application condition (Argo: type + message).
type ArgoConditionDTO struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// ArgoAppDTO is one Argo CD Application in Argo's own vocabulary.
type ArgoAppDTO struct {
	Namespace      string             `json:"namespace"`
	Name           string             `json:"name"`
	Project        string             `json:"project"`
	SyncStatus     string             `json:"syncStatus"`   // Synced | OutOfSync | Unknown
	HealthStatus   string             `json:"healthStatus"` // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
	Broken         bool               `json:"broken"`
	Revision       string             `json:"revision"`
	RepoURL        string             `json:"repoURL"`
	Path           string             `json:"path"`
	Chart          string             `json:"chart"`
	TargetRevision string             `json:"targetRevision"`
	ExtraSources   int                `json:"extraSources"`
	DestNamespace  string             `json:"destNamespace"`
	AutoSync       bool               `json:"autoSync"`
	OpPhase        string             `json:"opPhase"`
	OpMessage      string             `json:"opMessage"`
	Conditions     []ArgoConditionDTO `json:"conditions"`
	ReconciledUnix int64              `json:"reconciledUnix"` // 0 = never
}

// ArgoResultDTO is the list payload. Available=false with Message covers both
// "Argo CD not installed" and a failed list - never an empty list pretending
// to be a healthy zero.
type ArgoResultDTO struct {
	Available bool         `json:"available"`
	Message   string       `json:"message,omitempty"`
	Apps      []ArgoAppDTO `json:"apps"`
}

// ArgoService is bound to JS: Application listing + the two imperative
// triggers (refresh, sync). Like every write verb it returns ActionResultDTO;
// Protected gating happens in the frontend ConfirmDialog.
type ArgoService struct {
	lookup func(string) (ArgoConn, bool)
}

func NewArgoService(lookup func(string) (ArgoConn, bool)) *ArgoService {
	return &ArgoService{lookup: lookup}
}

// ListApplications returns every Application on the cluster, broken-first.
func (s *ArgoService) ListApplications(cluster string) ArgoResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ArgoResultDTO{Message: "cluster not connected: " + cluster, Apps: []ArgoAppDTO{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), argoTimeout)
	defer cancel()
	apps, err := conn.ListArgoApps(ctx)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return ArgoResultDTO{Message: "Argo CD not detected (no applications.argoproj.io resource)", Apps: []ArgoAppDTO{}}
		}
		return ArgoResultDTO{Message: err.Error(), Apps: []ArgoAppDTO{}}
	}
	out := make([]ArgoAppDTO, 0, len(apps))
	for _, a := range apps {
		dto := ArgoAppDTO{
			Namespace:      a.Namespace,
			Name:           a.Name,
			Project:        a.Project,
			SyncStatus:     a.SyncStatus,
			HealthStatus:   a.HealthStatus,
			Broken:         a.Broken(),
			Revision:       a.Revision,
			RepoURL:        a.RepoURL,
			Path:           a.Path,
			Chart:          a.Chart,
			TargetRevision: a.TargetRevision,
			ExtraSources:   a.ExtraSources,
			DestNamespace:  a.DestNamespace,
			AutoSync:       a.AutoSync,
			OpPhase:        a.OpPhase,
			OpMessage:      a.OpMessage,
			Conditions:     make([]ArgoConditionDTO, 0, len(a.Conditions)),
		}
		for _, c := range a.Conditions {
			dto.Conditions = append(dto.Conditions, ArgoConditionDTO{Type: c.Type, Message: c.Message})
		}
		if !a.ReconciledAt.IsZero() {
			dto.ReconciledUnix = a.ReconciledAt.Unix()
		}
		out = append(out, dto)
	}
	return ArgoResultDTO{Available: true, Apps: out}
}

// RefreshApp triggers a re-compare against the source (refresh annotation).
func (s *ArgoService) RefreshApp(cluster, namespace, name string) ActionResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ActionResultDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), argoTimeout)
	defer cancel()
	if err := conn.RefreshArgoApp(ctx, namespace, name); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}

// SyncApp starts a sync at the app's target revision (""=HEAD). Never prunes.
func (s *ArgoService) SyncApp(cluster, namespace, name, revision string) ActionResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ActionResultDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), argoTimeout)
	defer cancel()
	if err := conn.SyncArgoApp(ctx, namespace, name, revision); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}
