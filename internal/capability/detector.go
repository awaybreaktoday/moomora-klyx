package capability

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Official install-default namespaces and controller names.
// Non-default install paths (e.g. renamed namespaces) are not yet supported.
const (
	fluxNamespace          = "flux-system"
	fluxKustomizeController = "kustomize-controller"
	argoNamespace          = "argocd"
	argoAppController      = "argocd-application-controller"
)

// workloadKind distinguishes the two workload types the health probe supports.
type workloadKind int

const (
	deploymentWorkload  workloadKind = iota
	statefulSetWorkload workloadKind = iota
)

// Detector classifies capabilities for one cluster.
type Detector struct {
	cs kubernetes.Interface
}

func NewDetector(cs kubernetes.Interface) *Detector { return &Detector{cs: cs} }

// servedGroups returns the set of served "group/version" strings plus bare
// group names. Callers pin explicit versions where they matter.
func (d *Detector) servedGroups(ctx context.Context) (map[string]bool, error) {
	// client-go's ServerGroups() is not context-aware; _ = ctx is intentional
	// and should be revisited when upstream adds context support.
	_ = ctx
	lists, err := d.cs.Discovery().ServerGroups()
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
		// NOTE: not unit-tested because the fake discovery client does not
		// surface ServerGroups errors via PrependReactor.
		msg := fmt.Sprintf("capability detection failed: %v", err)
		return Set{
			GitOps:  GitOpsCapability{Base: Base{Tier: Absent, Reason: msg}},
			Network: NetworkCapability{Base: Base{Tier: Absent, Reason: msg}},
		}
	}
	return Set{
		GitOps:  d.detectGitOps(ctx, served),
		Network: d.detectNetwork(ctx, served),
	}
}

func (d *Detector) detectGitOps(ctx context.Context, served map[string]bool) GitOpsCapability {
	fluxPresent := served["kustomize.toolkit.fluxcd.io"]
	argoPresent := served["argoproj.io"]

	out := GitOpsCapability{}
	out.Flux.Present = fluxPresent
	out.Argo.Present = argoPresent
	out.Coexistence = fluxPresent && argoPresent

	if !fluxPresent && !argoPresent {
		out.Base = Base{Tier: Absent, Reason: "no Flux or Argo CRDs installed"}
		return out
	}

	var reasons []string
	if fluxPresent {
		healthy, reason := d.controllerHealthy(ctx, deploymentWorkload, fluxNamespace, fluxKustomizeController)
		out.Flux.Healthy = healthy
		if healthy {
			out.Flux.Controllers = []string{fluxKustomizeController}
		}
		if !healthy {
			reasons = append(reasons, "Flux installed but "+reason)
		}
	}
	if argoPresent {
		healthy, reason := d.controllerHealthy(ctx, statefulSetWorkload, argoNamespace, argoAppController)
		out.Argo.Healthy = healthy
		if !healthy {
			reasons = append(reasons, "Argo installed but "+reason)
		}
	}

	fluxOK := !fluxPresent || out.Flux.Healthy
	argoOK := !argoPresent || out.Argo.Healthy
	out.Base.Tier = Classify(true, fluxOK && argoOK)
	out.Base.Reason = strings.Join(reasons, "; ")
	return out
}

func (d *Detector) detectNetwork(ctx context.Context, served map[string]bool) NetworkCapability {
	out := NetworkCapability{}
	out.CiliumPresent = served["cilium.io"]

	gwVersion := ""
	switch {
	case served["gateway.networking.k8s.io/v1"]:
		gwVersion = "v1"
	case served["gateway.networking.k8s.io/v1beta1"]:
		gwVersion = "v1beta1"
	}
	out.GatewayAPIVersion = gwVersion
	out.HasEnvoyProxy = served["gateway.envoyproxy.io"]

	gwPresent := gwVersion != ""
	if !gwPresent && !out.CiliumPresent {
		out.Base = Base{Tier: Absent, Reason: "no Gateway API or Cilium CRDs installed"}
		return out
	}

	// Healthy requires Gateway API AND its data-plane operator (EnvoyProxy).
	healthy := gwPresent && out.HasEnvoyProxy
	out.Base.Tier = Classify(true, healthy)
	if !healthy {
		if gwPresent && !out.HasEnvoyProxy {
			out.Base.Reason = "Gateway API present but no EnvoyProxy (data plane) installed"
		} else if !gwPresent {
			out.Base.Reason = "Cilium present but Gateway API not installed"
		}
	}
	return out
}

// controllerHealthy reports whether a controller workload has its desired
// replicas ready. Deployments check AvailableReplicas; StatefulSets check
// ReadyReplicas.
func (d *Detector) controllerHealthy(ctx context.Context, kind workloadKind, ns, name string) (bool, string) {
	switch kind {
	case statefulSetWorkload:
		sts, err := d.cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, fmt.Sprintf("%s statefulset not found", name)
		}
		want := int32(1)
		if sts.Spec.Replicas != nil {
			want = *sts.Spec.Replicas
		}
		if sts.Status.ReadyReplicas < want {
			return false, fmt.Sprintf("%s is not ready (%d/%d ready)", name, sts.Status.ReadyReplicas, want)
		}
		return true, ""
	default: // deploymentWorkload
		dep, err := d.cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
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
}
