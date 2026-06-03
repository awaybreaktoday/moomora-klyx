package fleet

import "testing"

func TestSummarize(t *testing.T) {
	snaps := []Snapshot{
		{Name: "a", State: Synced, NodesReady: 12, NodesTotal: 12, Pods: 487},
		{Name: "b", State: Degraded, NodesReady: 10, NodesTotal: 10, Pods: 412},
		{Name: "c", State: Failed},
	}
	sum := Summarize(snaps)
	if sum.TotalClusters != 3 {
		t.Fatalf("want 3 total, got %d", sum.TotalClusters)
	}
	if sum.Answered != 2 {
		t.Fatalf("want 2 answered (Synced+Degraded), got %d", sum.Answered)
	}
	if sum.TotalPods != 899 {
		t.Fatalf("want 899 pods, got %d", sum.TotalPods)
	}
	if sum.NodesReady != 22 || sum.NodesTotal != 22 {
		t.Fatalf("want 22/22 nodes, got %d/%d", sum.NodesReady, sum.NodesTotal)
	}
	if !sum.Partial {
		t.Fatal("want Partial true when a cluster failed")
	}
}

func TestSummarizeComplete(t *testing.T) {
	snaps := []Snapshot{{Name: "a", State: Synced}, {Name: "b", State: Synced}}
	sum := Summarize(snaps)
	if sum.Partial {
		t.Fatal("want Partial false when all answered")
	}
}
