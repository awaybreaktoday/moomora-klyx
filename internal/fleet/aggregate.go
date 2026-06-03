package fleet

// FleetSummary is the aggregated fleet state. Answered counts clusters whose
// data is usable (Synced or Degraded); Partial is true when any cluster did not
// answer.
type FleetSummary struct {
	TotalClusters int
	Answered      int
	NodesReady    int
	NodesTotal    int
	TotalPods     int
	Partial       bool
}

func answered(s ConnState) bool { return s == Synced || s == Degraded || s == Stale }

func Summarize(snaps []Snapshot) FleetSummary {
	sum := FleetSummary{TotalClusters: len(snaps)}
	for _, s := range snaps {
		if !answered(s.State) {
			continue
		}
		sum.Answered++
		sum.NodesReady += s.NodesReady
		sum.NodesTotal += s.NodesTotal
		sum.TotalPods += s.Pods
	}
	sum.Partial = sum.Answered < sum.TotalClusters
	return sum
}
