package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
)

// DefaultKubeconfigPath resolves the kubeconfig Klyx reads contexts from:
// the first KUBECONFIG entry when set, else ~/.kube/config.
func DefaultKubeconfigPath() string {
	if env := os.Getenv("KUBECONFIG"); env != "" {
		parts := strings.Split(env, string(os.PathListSeparator))
		if len(parts) > 0 && parts[0] != "" {
			return parts[0]
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kube", "config")
}

// KubeContexts lists the context names declared in a kubeconfig, sorted.
// A missing file is not an error - it returns an empty list (a fresh machine
// simply has no contexts yet).
func KubeContexts(path string) ([]string, error) {
	if path == "" {
		return nil, nil
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	kc, err := clientcmd.LoadFromFile(path)
	if err != nil {
		return nil, fmt.Errorf("parse kubeconfig %q: %w", path, err)
	}
	out := make([]string, 0, len(kc.Contexts))
	for name := range kc.Contexts {
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}
