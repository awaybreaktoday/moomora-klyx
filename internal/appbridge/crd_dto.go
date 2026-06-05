package appbridge

import (
	"sort"

	"github.com/moomora/klyx/internal/crd"
)

// CRDKindDTO is one custom-resource kind within a group.
type CRDKindDTO struct {
	Kind       string   `json:"kind"`
	Plural     string   `json:"plural"`
	Scope      string   `json:"scope"`
	Version    string   `json:"version"`
	Operator   string   `json:"operator"`
	ShortNames []string `json:"shortNames"`
}

// CRDGroupDTO is an API group with its curated category and kinds.
type CRDGroupDTO struct {
	Group    string       `json:"group"`
	Category string       `json:"category"`
	Kinds    []CRDKindDTO `json:"kinds"`
}

// CRDCountDTO is a hybrid instance count for one kind.
type CRDCountDTO struct {
	Count  int  `json:"count"`
	Capped bool `json:"capped"`
}

// groupCRDs groups parsed CRDs by API group, attaches the curated category, and
// sorts groups and kinds by name for a stable UI.
func groupCRDs(infos []crd.Info) []CRDGroupDTO {
	byGroup := map[string][]CRDKindDTO{}
	for _, i := range infos {
		byGroup[i.Group] = append(byGroup[i.Group], CRDKindDTO{
			Kind: i.Kind, Plural: i.Plural, Scope: i.Scope,
			Version: i.Version, Operator: i.Operator, ShortNames: i.ShortNames,
		})
	}
	out := make([]CRDGroupDTO, 0, len(byGroup))
	for group, kinds := range byGroup {
		sort.Slice(kinds, func(a, b int) bool { return kinds[a].Kind < kinds[b].Kind })
		out = append(out, CRDGroupDTO{Group: group, Category: crd.Category(group), Kinds: kinds})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Group < out[b].Group })
	return out
}
