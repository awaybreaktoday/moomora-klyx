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

// DebugCommand builds the kubectl debug argv: an interactive ephemeral
// busybox container attached to the pod. --target shares the target
// container's process namespace, so a distroless container's processes (and
// filesystem, via /proc/1/root) are inspectable even though exec has no shell
// to run there. Honesty note carried to the UI: the ephemeral container stays
// listed on the pod spec until the pod is recreated - it exits with the
// shell, but Kubernetes has no API to remove it.
func (c *ClusterConn) DebugCommand(namespace, pod, container string) ([]string, error) {
	if c.kubeContext == "" {
		return nil, fmt.Errorf("cluster has no kubeconfig context")
	}
	argv := []string{
		"kubectl",
		"--context", c.kubeContext,
		"-n", namespace,
		"debug", "-it", pod,
		"--image=busybox:1.36",
	}
	if container != "" {
		argv = append(argv, "--target="+container)
	}
	argv = append(argv, "--", "sh")
	return argv, nil
}
