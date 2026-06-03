package capability

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Detector classifies capabilities for one cluster.
type Detector struct {
	cs kubernetes.Interface
}

func NewDetector(cs kubernetes.Interface) *Detector { return &Detector{cs: cs} }

func metaGetOptions() metav1.GetOptions { return metav1.GetOptions{} }

// servedGroups returns the set of served "group/version" strings plus bare
// group names. Callers pin explicit versions where they matter.
func (d *Detector) servedGroups(ctx context.Context) (map[string]bool, error) {
	lists, err := d.cs.Discovery().ServerGroups()
	_ = ctx
	if err != nil {
		return nil, err
	}
	served := make(map[string]bool)
	for _, g := range lists.Groups {
		for _, v := range g.Versions {
			served[v.GroupVersion] = true // e.g. "gateway.networking.k8s.io/v1"
			served[g.Name] = true         // bare group presence
		}
	}
	return served, nil
}

func (d *Detector) Detect(ctx context.Context) Set {
	served, err := d.servedGroups(ctx)
	if err != nil {
		served = map[string]bool{}
	}
	return Set{
		GitOps:  d.detectGitOps(ctx, served),
		Network: d.detectNetwork(ctx, served),
	}
}

func (d *Detector) detectGitOps(ctx context.Context, served map[string]bool) GitOpsCapability {
	fluxPresent := served["kustomize.toolkit.fluxcd.io"]
	argoPresent := served["argoproj.io"]

	cap := GitOpsCapability{}
	cap.Flux.Present = fluxPresent
	cap.Argo.Present = argoPresent
	cap.Coexistence = fluxPresent && argoPresent

	if !fluxPresent && !argoPresent {
		cap.Base = Base{Tier: Absent, Reason: "no Flux or Argo CRDs installed"}
		return cap
	}

	var reasons []string
	if fluxPresent {
		healthy, reason := d.controllerHealthy(ctx, "flux-system", "kustomize-controller")
		cap.Flux.Healthy = healthy
		cap.Flux.Controllers = []string{"kustomize-controller"}
		if !healthy {
			reasons = append(reasons, "Flux installed but "+reason)
		}
	}
	if argoPresent {
		healthy, reason := d.controllerHealthy(ctx, "argocd", "argocd-application-controller")
		cap.Argo.Healthy = healthy
		if !healthy {
			reasons = append(reasons, "Argo installed but "+reason)
		}
	}

	fluxOK := !fluxPresent || cap.Flux.Healthy
	argoOK := !argoPresent || cap.Argo.Healthy
	cap.Base.Tier = Classify(true, fluxOK && argoOK)
	cap.Base.Reason = strings.Join(reasons, "; ")
	return cap
}

func (d *Detector) detectNetwork(ctx context.Context, served map[string]bool) NetworkCapability {
	cap := NetworkCapability{}
	cap.CiliumPresent = served["cilium.io"]

	gwVersion := ""
	switch {
	case served["gateway.networking.k8s.io/v1"]:
		gwVersion = "v1"
	case served["gateway.networking.k8s.io/v1beta1"]:
		gwVersion = "v1beta1"
	}
	cap.GatewayAPIVersion = gwVersion
	cap.HasEnvoyProxy = served["gateway.envoyproxy.io"]

	gwPresent := gwVersion != ""
	if !gwPresent && !cap.CiliumPresent {
		cap.Base = Base{Tier: Absent, Reason: "no Gateway API or Cilium CRDs installed"}
		return cap
	}

	// Healthy requires Gateway API AND its data-plane operator (EnvoyProxy).
	healthy := gwPresent && cap.HasEnvoyProxy
	cap.Base.Tier = Classify(true, healthy)
	if !healthy {
		if gwPresent && !cap.HasEnvoyProxy {
			cap.Base.Reason = "Gateway API present but no EnvoyProxy (data plane) installed"
		} else if !gwPresent {
			cap.Base.Reason = "Cilium present but Gateway API not installed"
		}
	}
	return cap
}

// controllerHealthy reports whether a controller Deployment has its desired
// replicas available.
func (d *Detector) controllerHealthy(ctx context.Context, ns, name string) (bool, string) {
	dep, err := d.cs.AppsV1().Deployments(ns).Get(ctx, name, metaGetOptions())
	if err != nil {
		return false, fmt.Sprintf("%s deployment not found", name)
	}
	want := int32(1)
	if dep.Spec.Replicas != nil {
		want = *dep.Spec.Replicas
	}
	if dep.Status.AvailableReplicas < want {
		return false, fmt.Sprintf("%s is not ready (%d/%d available)", name, dep.Status.AvailableReplicas, want)
	}
	return true, ""
}
