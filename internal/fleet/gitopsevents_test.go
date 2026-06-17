package fleet

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	typedfake "k8s.io/client-go/kubernetes/fake"

	"github.com/moomora/klyx/internal/capability"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
)

func fluxEvent(name, kind, involvedName, ns, etype, reason, msg string) *corev1.Event {
	return &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: name, Namespace: ns},
		InvolvedObject: corev1.ObjectReference{Kind: kind, Name: involvedName, Namespace: ns},
		Type:           etype,
		Reason:         reason,
		Message:        msg,
	}
}

func TestFluxEventsFiltersByInvolvedObject(t *testing.T) {
	typed := typedfake.NewSimpleClientset(
		fluxEvent("e1", "Kustomization", "apps", "flux-system", "Normal", "ReconciliationSucceeded", "applied revision main@abc"),
		fluxEvent("e2", "Kustomization", "apps", "flux-system", "Warning", "DriftDetected", "Deployment/default/podinfo configured"),
		fluxEvent("e3", "Kustomization", "other", "flux-system", "Normal", "ReconciliationSucceeded", "not ours"),
		fluxEvent("e4", "HelmRelease", "apps", "flux-system", "Normal", "Released", "different kind"),
	)
	det := capability.NewDetector(typed)
	c := NewClusterConn("x", typed, nil, nil, det, clock.Real{}, config.MetricsConfig{})
	c.ctx = context.Background()

	evs, err := c.FluxEvents(context.Background(), "Kustomization", "flux-system", "apps")
	if err != nil {
		t.Fatalf("FluxEvents: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("want 2 events for Kustomization/apps, got %d: %+v", len(evs), evs)
	}
	for _, e := range evs {
		if e.Kind != "Kustomization" || e.Name != "apps" {
			t.Fatalf("leaked a non-matching event: %+v", e)
		}
	}
	// Warning sorts before Normal (SummarizeEvents ordering).
	if evs[0].Type != "Warning" || evs[0].Reason != "DriftDetected" {
		t.Fatalf("want the warning first, got %+v", evs[0])
	}
}
