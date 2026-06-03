package capability

import "testing"

func TestClassifyTier(t *testing.T) {
	cases := []struct {
		present bool
		healthy bool
		want    Tier
	}{
		{present: false, healthy: false, want: Absent},
		{present: true, healthy: false, want: Degraded},
		{present: true, healthy: true, want: Healthy},
	}
	for _, tc := range cases {
		if got := Classify(tc.present, tc.healthy); got != tc.want {
			t.Errorf("Classify(%v,%v)=%v want %v", tc.present, tc.healthy, got, tc.want)
		}
	}
}

func TestSetReports(t *testing.T) {
	s := Set{
		GitOps: GitOpsCapability{
			Base: Base{Tier: Degraded, Reason: "kustomize-controller not ready"},
			Flux: FluxInfo{Present: true, Version: "v2.4.0", Healthy: false},
		},
	}
	if s.GitOps.Tier != Degraded {
		t.Fatalf("want Degraded, got %v", s.GitOps.Tier)
	}
	if s.GitOps.Reason == "" {
		t.Fatal("degraded capability must carry a reason")
	}
}
