package capability

// ControllerRef identifies a GitOps controller workload to watch for health.
type ControllerRef struct {
	Tool      string // "flux" | "argo"
	Kind      string // "Deployment" | "StatefulSet"
	Namespace string
	Name      string
}

// ControllerRefs returns the controller workloads to watch for the GitOps tools
// present in s. Empty if neither Flux nor Argo is present.
func ControllerRefs(s Set) []ControllerRef {
	var refs []ControllerRef
	if s.GitOps.Flux.Present {
		refs = append(refs, ControllerRef{
			Tool: "flux", Kind: "Deployment",
			Namespace: fluxNamespace, Name: fluxKustomizeController,
		})
	}
	if s.GitOps.Argo.Present {
		refs = append(refs, ControllerRef{
			Tool: "argo", Kind: "StatefulSet",
			Namespace: argoNamespace, Name: argoAppController,
		})
	}
	return refs
}

// WithGitOpsHealth returns a copy of s.GitOps with the tier, reason, and per-tool
// Healthy flags recomputed from fresh controller readiness. Presence, version,
// and coexistence are preserved. Readiness args are consulted only for tools that
// are present in s.
func WithGitOpsHealth(s Set, fluxHealthy, argoHealthy bool) GitOpsCapability {
	out := s.GitOps
	if out.Flux.Present {
		out.Flux.Healthy = fluxHealthy
		if fluxHealthy {
			out.Flux.Controllers = []string{fluxKustomizeController}
		} else {
			out.Flux.Controllers = nil
		}
	}
	if out.Argo.Present {
		out.Argo.Healthy = argoHealthy
	}
	tier, reason := gitOpsTier(out.Flux, out.Argo)
	out.Base.Tier = tier
	out.Base.Reason = reason
	return out
}
