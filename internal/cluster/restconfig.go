// Package cluster resolves per-cluster credentials from kubeconfig. Exec
// credential plugins (kubelogin, aws eks get-token) are invoked automatically
// by client-go when the resolved context uses them.
package cluster

import (
	"fmt"
	"os"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/moomora/klyx/internal/config"
)

// RESTConfig builds a *rest.Config for the cluster's kubeconfig context.
func RESTConfig(cc config.ClusterConfig) (*rest.Config, error) {
	kubeconfigPath := cc.Kubeconfig
	if kubeconfigPath == "" {
		kubeconfigPath = os.Getenv("KUBECONFIG")
	}
	if kubeconfigPath == "" {
		if home, err := os.UserHomeDir(); err == nil {
			kubeconfigPath = home + "/.kube/config"
		}
	}
	loadingRules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath}
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
