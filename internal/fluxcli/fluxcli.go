// Package fluxcli is a pure adapter over the flux CLI. It shells out to the
// flux binary for the one operation that genuinely needs it - an on-demand,
// local-build live-vs-Git diff (`flux diff kustomization`). The CLI inherits
// the shell's per-cloud auth, so SOPS via age/GPG + AWS/Azure/GCP KMS all work
// with no provider-specific code here. All functions accept a Runner so tests
// can inject a fake without spawning real processes.
package fluxcli

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Runner executes a flux invocation. Unlike a plain runner it returns stdout AND
// stderr AND the run error separately, because `flux diff` writes the diff to
// stdout and exits non-zero when drift exists - so stdout must not be discarded
// on a non-zero exit.
type Runner interface {
	Run(ctx context.Context, args ...string) (stdout []byte, stderr string, err error)
}

// ExecRunner is the production Runner that executes flux via exec.CommandContext.
type ExecRunner struct{}

var (
	lookPath          = exec.LookPath
	executableExists  = defaultExecutableExists
	fluxFallbackPaths = defaultFluxFallbackPaths
)

func (ExecRunner) Run(ctx context.Context, args ...string) ([]byte, string, error) {
	bin, ok := Resolve()
	if !ok {
		bin = "flux"
	}
	cmd := exec.CommandContext(ctx, bin, args...) //nolint:gosec
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), strings.TrimSpace(stderr.String()), err
}

// Detect reports whether the flux binary is available to Klyx.
func Detect() bool {
	_, ok := Resolve()
	return ok
}

// Resolve returns the flux executable Klyx should use. macOS .app launches do
// not inherit the user's interactive shell PATH, so we also check the usual
// package-manager locations.
func Resolve() (string, bool) {
	if configured := strings.TrimSpace(os.Getenv("KLYX_FLUX_PATH")); configured != "" {
		if executableExists(configured) {
			return configured, true
		}
	}
	if p, err := lookPath("flux"); err == nil {
		return p, true
	}
	for _, candidate := range fluxFallbackPaths() {
		if executableExists(candidate) {
			return candidate, true
		}
	}
	return "", false
}

func defaultExecutableExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0111 != 0
}

func defaultFluxFallbackPaths() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"/opt/homebrew/bin/flux", "/usr/local/bin/flux", "/opt/local/bin/flux"}
	case "linux":
		return []string{"/usr/local/bin/flux", "/usr/bin/flux", "/snap/bin/flux"}
	case "windows":
		var paths []string
		if root := strings.TrimSpace(os.Getenv("ChocolateyInstall")); root != "" {
			paths = append(paths, filepath.Join(root, "bin", "flux.exe"))
		}
		if root := strings.TrimSpace(os.Getenv("ProgramFiles")); root != "" {
			paths = append(paths, filepath.Join(root, "flux", "flux.exe"))
		}
		return paths
	default:
		return nil
	}
}

// DiffResult is the outcome of `flux diff kustomization`.
type DiffResult struct {
	Output     string // the diff text (when HasChanges)
	HasChanges bool
	Err        string // a real failure (flux missing, build/decrypt/auth error)
}

// DiffKustomization runs `flux diff kustomization <name> -n <ns> --path <path>`
// against the given kubeContext. path is a LOCAL filesystem path to the built
// manifests (flux builds locally and dry-runs against the cluster - no clone).
//
// flux writes the diff to stdout and may exit non-zero when drift exists, so we
// treat any stdout content as the diff (HasChanges) regardless of exit code, and
// only surface an error when there is no diff output and the command failed.
func DiffKustomization(ctx context.Context, r Runner, kubeContext, ns, name, path string) DiffResult {
	args := []string{"diff", "kustomization", name, "-n", ns, "--path", path}
	if kubeContext != "" {
		args = append(args, "--context", kubeContext)
	}
	stdout, stderr, err := r.Run(ctx, args...)
	out := strings.TrimSpace(string(stdout))
	if out != "" {
		return DiffResult{Output: out, HasChanges: true}
	}
	if err != nil {
		msg := stderr
		if msg == "" {
			msg = err.Error()
		}
		return DiffResult{Err: msg}
	}
	return DiffResult{HasChanges: false}
}
