// Package appbridge is the only Wails-aware Go layer. It projects the pure
// fleet data layer into JSON-friendly DTOs and pushes updates to the frontend.
package appbridge

import (
	"time"

	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/fleet"
)

// ClusterDTO is the JSON-friendly per-cluster shape the frontend consumes.
type ClusterDTO struct {
	Name          string `json:"name"`
	State         string `json:"state"`
	Reason        string `json:"reason"`
	NodesReady    int    `json:"nodesReady"`
	NodesTotal    int    `json:"nodesTotal"`
	Pods          int    `json:"pods"`
	Version       string `json:"version"`
	GitopsTier    string `json:"gitopsTier"`
	GitopsReason  string `json:"gitopsReason"`
	NetworkTier   string `json:"networkTier"`
	NetworkReason string `json:"networkReason"`
	Env           string `json:"env"`
	Region        string `json:"region"`
	Provider      string `json:"provider"`
	Group         string `json:"group"`
	AgeSeconds    int64  `json:"ageSeconds"`
}

// ToDTO projects a snapshot + its config into a ClusterDTO. now is injected so
// age is deterministic in tests and consistent across a batch.
func ToDTO(s fleet.Snapshot, cc config.ClusterConfig, now time.Time) ClusterDTO {
	age := int64(0)
	if !s.LastSync.IsZero() {
		age = int64(now.Sub(s.LastSync).Seconds())
		if age < 0 {
			age = 0
		}
	}
	return ClusterDTO{
		Name:          s.Name,
		State:         s.State.String(),
		Reason:        s.Reason,
		NodesReady:    s.NodesReady,
		NodesTotal:    s.NodesTotal,
		Pods:          s.Pods,
		Version:       s.Version,
		GitopsTier:    s.Capabilities.GitOps.Tier.String(),
		GitopsReason:  s.Capabilities.GitOps.Reason,
		NetworkTier:   s.Capabilities.Network.Tier.String(),
		NetworkReason: s.Capabilities.Network.Reason,
		Env:           cc.Tags["env"],
		Region:        cc.Tags["region"],
		Provider:      cc.Tags["provider"],
		Group:         cc.Group,
		AgeSeconds:    age,
	}
}
