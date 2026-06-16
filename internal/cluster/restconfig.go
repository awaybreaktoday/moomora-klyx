// Package cluster resolves per-cluster credentials from kubeconfig. Exec
// credential plugins (kubelogin, aws eks get-token) are invoked automatically
// by client-go when the resolved context uses them.
package cluster

import (
	"fmt"
	"os"
	"strings"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/execenv"
)

// RESTConfig builds a *rest.Config for the cluster's kubeconfig context.
func RESTConfig(cc config.ClusterConfig) (*rest.Config, error) {
	execenv.ApplyDesktopToolPath()

	kubeconfigPath := cc.Kubeconfig
	loadingRules := kubeconfigLoadingRules(kubeconfigPath)
	overrides := &clientcmd.ConfigOverrides{CurrentContext: cc.Context}
	cc2 := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides)
	rc, err := cc2.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("resolve rest config for context %q: %w", cc.Context, err)
	}
	// client-go defaults to 5 QPS / 10 burst - kubectl-conservative and far too
	// low for a platform tool that fans out reads across a cluster's CRD kinds
	// (a CRD browser counting ~100 kinds would otherwise queue for minutes behind
	// client-side throttling). Raise it; the apiserver's API Priority & Fairness
	// still protects the server. Only applied when the kubeconfig did not set it.
	if rc.QPS == 0 {
		rc.QPS = 50
	}
	if rc.Burst == 0 {
		rc.Burst = 100
	}
	return rc, nil
}

func kubeconfigLoadingRules(path string) *clientcmd.ClientConfigLoadingRules {
	if path == "" {
		return clientcmd.NewDefaultClientConfigLoadingRules()
	}
	parts := splitKubeconfigPathList(path)
	if len(parts) > 1 {
		return &clientcmd.ClientConfigLoadingRules{Precedence: parts}
	}
	return &clientcmd.ClientConfigLoadingRules{ExplicitPath: path}
}

func splitKubeconfigPathList(path string) []string {
	raw := strings.Split(path, string(os.PathListSeparator))
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
