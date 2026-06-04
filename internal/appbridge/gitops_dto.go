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
