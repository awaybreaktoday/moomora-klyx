package appbridge

type OwnerDTO struct {
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type PodDTO struct {
	Name       string `json:"name"`
	Ready      bool   `json:"ready"`
	Restarts   int    `json:"restarts"`
	Reason     string `json:"reason"`
	Node       string `json:"node"`
	AgeSeconds int    `json:"ageSeconds"`
}

type WorkloadDTO struct {
	Kind      string    `json:"kind"`
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	Desired   int       `json:"desired"`
	Ready     int       `json:"ready"`
	Available int       `json:"available"`
	Updated   int       `json:"updated"`
	Restarts  int       `json:"restarts"`
	Reason    string    `json:"reason"`
	Rank      string    `json:"rank"` // "unhealthy"|"degraded"|"restarts"|"healthy"
	GitOps    *OwnerDTO `json:"gitops"`
	Pods      []PodDTO  `json:"pods"`
}

type WorkloadsResultDTO struct {
	FluxPresent bool          `json:"fluxPresent"`
	Namespaces  []string      `json:"namespaces"` // populated only when namespace==""
	Workloads   []WorkloadDTO `json:"workloads"`
}
