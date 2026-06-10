package fleet

import (
	"testing"
)

func TestExecCommand(t *testing.T) {
	conn := &ClusterConn{kubeContext: "prod-aks"}

	t.Run("with container", func(t *testing.T) {
		got, err := conn.ExecCommand("default", "web-abc", "web")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{
			"kubectl",
			"--context", "prod-aks",
			"-n", "default",
			"exec", "-it", "web-abc",
			"-c", "web",
			"--",
			"/bin/sh", "-c",
			"command -v bash >/dev/null && exec bash || exec sh",
		}
		if len(got) != len(want) {
			t.Fatalf("argv length mismatch: got %d want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("argv[%d]: got %q want %q", i, got[i], want[i])
			}
		}
	})

	t.Run("without container", func(t *testing.T) {
		got, err := conn.ExecCommand("monitoring", "grafana-xyz", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{
			"kubectl",
			"--context", "prod-aks",
			"-n", "monitoring",
			"exec", "-it", "grafana-xyz",
			"--",
			"/bin/sh", "-c",
			"command -v bash >/dev/null && exec bash || exec sh",
		}
		if len(got) != len(want) {
			t.Fatalf("argv length mismatch: got %d want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("argv[%d]: got %q want %q", i, got[i], want[i])
			}
		}
	})

	t.Run("empty kubeContext error", func(t *testing.T) {
		empty := &ClusterConn{kubeContext: ""}
		_, err := empty.ExecCommand("default", "pod-xyz", "app")
		if err == nil {
			t.Fatal("expected error for empty kubeContext, got nil")
		}
		const want = "cluster has no kubeconfig context"
		if err.Error() != want {
			t.Errorf("error message: got %q want %q", err.Error(), want)
		}
	})
}
