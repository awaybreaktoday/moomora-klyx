package appbridge

import (
	"sort"

	"github.com/moomora/klyx/internal/config"
)

// FleetClusterDTO is one configured fleet entry as Settings shows it.
type FleetClusterDTO struct {
	Name       string `json:"name"`
	Context    string `json:"context"`
	Env        string `json:"env"`
	Group      string `json:"group"`
	Protected  bool   `json:"protected"`
	HasMetrics bool   `json:"hasMetrics"`
}

// KubeContextDTO is one kubeconfig context with its fleet membership.
type KubeContextDTO struct {
	Name    string `json:"name"`
	InFleet bool   `json:"inFleet"`
}

// FleetConfigDTO is the Settings payload: the loaded fleet config plus a FRESH
// kubeconfig scan (re-read on every call, so a context added to ~/.kube/config
// after startup shows up without restarting Klyx).
type FleetConfigDTO struct {
	Path           string            `json:"path"`
	KubeconfigPath string            `json:"kubeconfigPath"`
	Warnings       []string          `json:"warnings"`
	ScanError      string            `json:"scanError,omitempty"`
	Clusters       []FleetClusterDTO `json:"clusters"`
	Contexts       []KubeContextDTO  `json:"contexts"`
}

// ConfigService exposes the fleet configuration to Settings. It reads the
// STARTUP config (the one the registry was built from); AddClusters appends to
// the file on disk and the caller restarts Klyx to connect - the service never
// mutates the running fleet.
type ConfigService struct {
	path string
	cfg  *config.Config
	// seams for tests
	kubeconfigPath func() string
	kubeContexts   func(string) ([]string, error)
	appendClusters func(string, []string) error
}

func NewConfigService(path string, cfg *config.Config) *ConfigService {
	return &ConfigService{
		path:           path,
		cfg:            cfg,
		kubeconfigPath: config.DefaultKubeconfigPath,
		kubeContexts:   config.KubeContexts,
		appendClusters: config.AppendClusters,
	}
}

// GetFleetConfig returns the fleet file state plus a fresh kubeconfig context
// scan. Scan failure is reported in ScanError, never fabricated as "no
// contexts".
func (s *ConfigService) GetFleetConfig() FleetConfigDTO {
	dto := FleetConfigDTO{
		Path:           s.path,
		KubeconfigPath: s.kubeconfigPath(),
		Warnings:       s.cfg.Warnings(),
		Clusters:       make([]FleetClusterDTO, 0, len(s.cfg.Clusters)),
		Contexts:       []KubeContextDTO{},
	}
	inFleet := map[string]bool{}
	for _, c := range s.cfg.Clusters {
		inFleet[c.Name] = true
		inFleet[c.Context] = true
		dto.Clusters = append(dto.Clusters, FleetClusterDTO{
			Name:       c.Name,
			Context:    c.Context,
			Env:        c.Env(),
			Group:      c.Group,
			Protected:  c.Protected,
			HasMetrics: c.Metrics != nil,
		})
	}
	sort.Slice(dto.Clusters, func(a, b int) bool { return dto.Clusters[a].Name < dto.Clusters[b].Name })

	ctxs, err := s.kubeContexts(dto.KubeconfigPath)
	if err != nil {
		dto.ScanError = err.Error()
		return dto
	}
	for _, name := range ctxs {
		dto.Contexts = append(dto.Contexts, KubeContextDTO{Name: name, InFleet: inFleet[name]})
	}
	return dto
}

// NewContextCount returns how many kubeconfig contexts are not in the fleet -
// the sidebar badge. Scan failures count as zero (the badge never lies about
// data it could not read; Settings shows the error).
func (s *ConfigService) NewContextCount() int {
	n := 0
	for _, c := range s.GetFleetConfig().Contexts {
		if !c.InFleet {
			n++
		}
	}
	return n
}

// AddClusters appends the given kubeconfig contexts to the fleet file
// (validated before write; comments preserved). The running fleet is NOT
// reloaded - the result message tells the user to restart Klyx.
func (s *ConfigService) AddClusters(contexts []string) ActionResultDTO {
	if len(contexts) == 0 {
		return ActionResultDTO{Error: "no contexts selected"}
	}
	if err := s.appendClusters(s.path, contexts); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}
