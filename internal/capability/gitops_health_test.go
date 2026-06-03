package capability

import "testing"

func TestControllerRefs(t *testing.T) {
	fluxOnly := Set{GitOps: GitOpsCapability{Flux: FluxInfo{Present: true}}}
	refs := ControllerRefs(fluxOnly)
	if len(refs) != 1 || refs[0].Tool != "flux" || refs[0].Kind != "Deployment" ||
		refs[0].Namespace != "flux-system" || refs[0].Name != "kustomize-controller" {
		t.Fatalf("flux-only refs wrong: %+v", refs)
	}

	argoOnly := Set{GitOps: GitOpsCapability{Argo: ArgoInfo{Present: true}}}
	refs = ControllerRefs(argoOnly)
	if len(refs) != 1 || refs[0].Tool != "argo" || refs[0].Kind != "StatefulSet" ||
		refs[0].Namespace != "argocd" || refs[0].Name != "argocd-application-controller" {
		t.Fatalf("argo-only refs wrong: %+v", refs)
	}

	both := Set{GitOps: GitOpsCapability{Flux: FluxInfo{Present: true}, Argo: ArgoInfo{Present: true}}}
	if len(ControllerRefs(both)) != 2 {
		t.Fatalf("both: want 2 refs")
	}

	if len(ControllerRefs(Set{})) != 0 {
		t.Fatalf("neither: want 0 refs")
	}
}

func TestWithGitOpsHealth(t *testing.T) {
	base := Set{GitOps: GitOpsCapability{
		Base: Base{Tier: Healthy},
		Flux: FluxInfo{Present: true, Version: "v2.4.0", Healthy: true},
	}}

	g := WithGitOpsHealth(base, true, false)
	if g.Tier != Healthy || g.Reason != "" {
		t.Fatalf("want Healthy/empty, got %v/%q", g.Tier, g.Reason)
	}
	if g.Flux.Version != "v2.4.0" {
		t.Fatalf("version not preserved: %q", g.Flux.Version)
	}
	if len(g.Flux.Controllers) != 1 {
		t.Fatalf("want Controllers populated when healthy")
	}

	g = WithGitOpsHealth(base, false, false)
	if g.Tier != Degraded || g.Reason == "" {
		t.Fatalf("want Degraded/reason, got %v/%q", g.Tier, g.Reason)
	}
	if len(g.Flux.Controllers) != 0 {
		t.Fatalf("want Controllers cleared when unhealthy")
	}

	co := Set{GitOps: GitOpsCapability{
		Base:        Base{Tier: Healthy},
		Flux:        FluxInfo{Present: true, Healthy: true},
		Argo:        ArgoInfo{Present: true, Healthy: true},
		Coexistence: true,
	}}
	g = WithGitOpsHealth(co, true, false)
	if g.Tier != Degraded {
		t.Fatalf("want Degraded when argo unhealthy, got %v", g.Tier)
	}
	if !g.Coexistence {
		t.Fatal("coexistence must be preserved")
	}
}
