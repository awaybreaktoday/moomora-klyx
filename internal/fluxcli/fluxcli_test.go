package fluxcli

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeRunner returns canned stdout/stderr/err and records args.
type fakeRunner struct {
	args   [][]string
	stdout string
	stderr string
	err    error
}

func (f *fakeRunner) Run(_ context.Context, args ...string) ([]byte, string, error) {
	f.args = append(f.args, append([]string(nil), args...))
	return []byte(f.stdout), f.stderr, f.err
}

func TestDiffKustomizationHasChanges(t *testing.T) {
	// flux prints the diff to stdout and exits non-zero when drift exists.
	r := &fakeRunner{stdout: "► Deployment/default/podinfo drifted\n± spec.replicas: 2 -> 3\n", err: errors.New("exit status 1")}
	res := DiffKustomization(context.Background(), r, "kind-dev", "flux-system", "apps", "./apps")
	if !res.HasChanges {
		t.Fatalf("want HasChanges, got %+v", res)
	}
	if res.Err != "" {
		t.Fatalf("a diff with output is not an error: %+v", res)
	}
	if !strings.Contains(res.Output, "podinfo drifted") {
		t.Fatalf("output: %q", res.Output)
	}
	// args carry context + path
	got := strings.Join(r.args[0], " ")
	for _, want := range []string{"diff", "kustomization", "apps", "-n flux-system", "--path ./apps", "--context kind-dev"} {
		if !strings.Contains(got, want) {
			t.Fatalf("args %q missing %q", got, want)
		}
	}
}

func TestDiffKustomizationNoChanges(t *testing.T) {
	r := &fakeRunner{stdout: "", err: nil}
	res := DiffKustomization(context.Background(), r, "", "flux-system", "apps", "./apps")
	if res.HasChanges || res.Err != "" {
		t.Fatalf("want clean result, got %+v", res)
	}
}

func TestDiffKustomizationRealError(t *testing.T) {
	// Non-zero exit with no stdout and a stderr message is a real failure.
	r := &fakeRunner{stdout: "", stderr: "unable to decrypt: no key", err: errors.New("exit status 1")}
	res := DiffKustomization(context.Background(), r, "", "flux-system", "apps", "./apps")
	if res.HasChanges {
		t.Fatalf("not a diff: %+v", res)
	}
	if !strings.Contains(res.Err, "decrypt") {
		t.Fatalf("want stderr surfaced, got %+v", res)
	}
}
