package fleet

import "fmt"

// ExecCommand returns the kubectl exec invocation for an interactive shell in
// the container, as argv (no shell quoting — the caller renders or launches it).
// Probes nothing: /bin/sh is the universal fallback.
//
// The shell expression uses the bash-if-available trick: command -v bash checks
// whether bash is on PATH without spawning a subshell, and execs into it if
// found, otherwise falls back to sh. This gives a better interactive experience
// on nodes that have bash (most distros) while remaining safe on minimal images.
//
// Returns an error if kubeContext is empty ("cluster has no kubeconfig context").
func (c *ClusterConn) ExecCommand(namespace, pod, container string) ([]string, error) {
	if c.kubeContext == "" {
		return nil, fmt.Errorf("cluster has no kubeconfig context")
	}
	argv := []string{
		"kubectl",
		"--context", c.kubeContext,
		"-n", namespace,
		"exec", "-it", pod,
	}
	if container != "" {
		argv = append(argv, "-c", container)
	}
	argv = append(argv,
		"--",
		"/bin/sh", "-c",
		"command -v bash >/dev/null && exec bash || exec sh",
	)
	return argv, nil
}
