package appbridge

import (
	"time"

	"github.com/moomora/klyx/internal/gitops/flux"
)

// FluxResourceDTO is the JSON projection of a Flux reconciliation resource.
type FluxResourceDTO struct {
	Kind                  string `json:"kind"`
	Namespace             string `json:"namespace"`
	Name                  string `json:"name"`
	Ready                 string `json:"ready"`
	Message               string `json:"message"`
	Revision              string `json:"revision"`
	LastAppliedAgeSeconds int64  `json:"lastAppliedAgeSeconds"`
	Suspended             bool   `json:"suspended"`
	SourceKind            string `json:"sourceKind"`
	SourceName            string `json:"sourceName"`
}

func ToFluxDTO(r flux.Resource, now time.Time) FluxResourceDTO {
	age := int64(0)
	if !r.LastApplied.IsZero() {
		age = int64(now.Sub(r.LastApplied).Seconds())
		if age < 0 {
			age = 0
		}
	}
	return FluxResourceDTO{
		Kind:                  string(r.Kind),
		Namespace:             r.Namespace,
		Name:                  r.Name,
		Ready:                 string(r.Ready),
		Message:               r.Message,
		Revision:              r.Revision,
		LastAppliedAgeSeconds: age,
		Suspended:             r.Suspended,
		SourceKind:            r.SourceKind,
		SourceName:            r.SourceName,
	}
}

type ConditionDTO struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type InventoryEntryDTO struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type ResourceDetailDTO struct {
	Kind              string              `json:"kind"`
	Namespace         string              `json:"namespace"`
	Name              string              `json:"name"`
	AppliedRevision   string              `json:"appliedRevision"`
	AttemptedRevision string              `json:"attemptedRevision"`
	ApplyFailed       bool                `json:"applyFailed"`
	Conditions        []ConditionDTO      `json:"conditions"`
	Inventory         []InventoryEntryDTO `json:"inventory"`
}

func toDetailDTO(d flux.Detail) ResourceDetailDTO {
	out := ResourceDetailDTO{
		Kind:              string(d.Kind),
		Namespace:         d.Namespace,
		Name:              d.Name,
		AppliedRevision:   d.AppliedRevision,
		AttemptedRevision: d.AttemptedRevision,
		ApplyFailed:       d.AttemptedRevision != "" && d.AttemptedRevision != d.AppliedRevision,
	}
	for _, c := range d.Conditions {
		out.Conditions = append(out.Conditions, ConditionDTO{Type: c.Type, Status: c.Status, Reason: c.Reason, Message: c.Message})
	}
	for _, e := range d.Inventory {
		out.Inventory = append(out.Inventory, InventoryEntryDTO{Group: e.Group, Version: e.Version, Kind: e.Kind, Namespace: e.Namespace, Name: e.Name})
	}
	return out
}
