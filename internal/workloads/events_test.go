package workloads

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// epoch helpers
var (
	t100 = time.Unix(100, 0).UTC()
	t200 = time.Unix(200, 0).UTC()
	t300 = time.Unix(300, 0).UTC()
)

func makeEvent(evType, reason, message, ns, kind, name string, count int32, last, first time.Time) corev1.Event {
	e := corev1.Event{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: ns,
		},
		InvolvedObject: corev1.ObjectReference{Kind: kind, Name: name},
		Type:           evType,
		Reason:         reason,
		Message:        message,
		Count:          count,
	}
	if !last.IsZero() {
		e.LastTimestamp = metav1.NewTime(last)
	}
	if !first.IsZero() {
		e.FirstTimestamp = metav1.NewTime(first)
	}
	return e
}

// TestSummarizeEvents_WarningFirst ensures all Warning rows precede Normal rows.
func TestSummarizeEvents_WarningFirst(t *testing.T) {
	events := []corev1.Event{
		makeEvent("Normal", "Pulled", "pulled", "ns", "Pod", "web", 1, t100, t100),
		makeEvent("Warning", "BackOff", "crash", "ns", "Pod", "api", 3, t200, t100),
		makeEvent("Normal", "Started", "started", "ns", "Pod", "web", 1, t300, t100),
		makeEvent("Warning", "OOMKilled", "oom", "ns", "Pod", "db", 2, t100, t100),
	}
	out := SummarizeEvents(events)
	if len(out) != 4 {
		t.Fatalf("want 4 rows, got %d", len(out))
	}
	// First two must be Warning.
	for i := 0; i < 2; i++ {
		if out[i].Type != "Warning" {
			t.Errorf("out[%d].Type = %q, want Warning", i, out[i].Type)
		}
	}
	// Last two must be Normal.
	for i := 2; i < 4; i++ {
		if out[i].Type != "Normal" {
			t.Errorf("out[%d].Type = %q, want Normal", i, out[i].Type)
		}
	}
}

// TestSummarizeEvents_RecencyWithinType ensures most-recent-first within each type.
func TestSummarizeEvents_RecencyWithinType(t *testing.T) {
	events := []corev1.Event{
		makeEvent("Warning", "OldWarn", "old", "ns", "Pod", "a", 1, t100, t100),
		makeEvent("Warning", "NewWarn", "new", "ns", "Pod", "b", 1, t300, t100),
		makeEvent("Normal", "OldNorm", "old", "ns", "Pod", "c", 1, t100, t100),
		makeEvent("Normal", "NewNorm", "new", "ns", "Pod", "d", 1, t200, t100),
	}
	out := SummarizeEvents(events)
	// Warnings: NewWarn (t300) before OldWarn (t100).
	if out[0].Reason != "NewWarn" {
		t.Errorf("out[0].Reason = %q, want NewWarn", out[0].Reason)
	}
	if out[1].Reason != "OldWarn" {
		t.Errorf("out[1].Reason = %q, want OldWarn", out[1].Reason)
	}
	// Normals: NewNorm (t200) before OldNorm (t100).
	if out[2].Reason != "NewNorm" {
		t.Errorf("out[2].Reason = %q, want NewNorm", out[2].Reason)
	}
	if out[3].Reason != "OldNorm" {
		t.Errorf("out[3].Reason = %q, want OldNorm", out[3].Reason)
	}
}

// TestSummarizeEvents_CountSources checks legacy count, series count, and default-1.
func TestSummarizeEvents_CountSources(t *testing.T) {
	// Series count takes precedence over e.Count.
	seriesEvent := makeEvent("Warning", "Crash", "msg", "ns", "Pod", "x", 5, t100, t100)
	seriesEvent.Series = &corev1.EventSeries{
		Count:            42,
		LastObservedTime: metav1.NewMicroTime(t200),
	}

	// Legacy count only.
	legacyEvent := makeEvent("Normal", "Pull", "msg", "ns", "Pod", "y", 7, t100, t100)

	// Neither set - defaults to 1.
	zeroCount := makeEvent("Normal", "Sched", "msg", "ns", "Pod", "z", 0, t100, t100)

	out := SummarizeEvents([]corev1.Event{seriesEvent, legacyEvent, zeroCount})
	byReason := map[string]EventSummary{}
	for _, s := range out {
		byReason[s.Reason] = s
	}

	if byReason["Crash"].Count != 42 {
		t.Errorf("series count: got %d, want 42", byReason["Crash"].Count)
	}
	if byReason["Pull"].Count != 7 {
		t.Errorf("legacy count: got %d, want 7", byReason["Pull"].Count)
	}
	if byReason["Sched"].Count != 1 {
		t.Errorf("default count: got %d, want 1", byReason["Sched"].Count)
	}
}

// TestSummarizeEvents_TimestampFallback checks the three-tier timestamp chain.
func TestSummarizeEvents_TimestampFallback(t *testing.T) {
	// Tier 1: series.lastObservedTime wins even when lastTimestamp is set.
	seriesTs := makeEvent("Warning", "R1", "m", "ns", "Pod", "p1", 1, t100, t100)
	seriesTs.Series = &corev1.EventSeries{
		Count:            1,
		LastObservedTime: metav1.NewMicroTime(t300),
	}

	// Tier 2: lastTimestamp wins over eventTime.
	legacyTs := makeEvent("Warning", "R2", "m", "ns", "Pod", "p2", 1, t200, time.Time{})
	legacyTs.EventTime = metav1.NewMicroTime(t100)

	// Tier 3: only eventTime set.
	eventTimeOnly := corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Namespace: "ns"},
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "p3"},
		Type:           "Normal", Reason: "R3", Message: "m",
		Count:     1,
		EventTime: metav1.NewMicroTime(t200),
	}

	// Tier 4: nothing set - LastSeenUnix = 0.
	noTs := makeEvent("Normal", "R4", "m", "ns", "Pod", "p4", 1, time.Time{}, time.Time{})

	out := SummarizeEvents([]corev1.Event{seriesTs, legacyTs, eventTimeOnly, noTs})
	byReason := map[string]EventSummary{}
	for _, s := range out {
		byReason[s.Reason] = s
	}

	if byReason["R1"].LastSeenUnix != t300.Unix() {
		t.Errorf("R1 series.lastObservedTime: got %d, want %d", byReason["R1"].LastSeenUnix, t300.Unix())
	}
	if byReason["R2"].LastSeenUnix != t200.Unix() {
		t.Errorf("R2 lastTimestamp: got %d, want %d", byReason["R2"].LastSeenUnix, t200.Unix())
	}
	if byReason["R3"].LastSeenUnix != t200.Unix() {
		t.Errorf("R3 eventTime: got %d, want %d", byReason["R3"].LastSeenUnix, t200.Unix())
	}
	if byReason["R4"].LastSeenUnix != 0 {
		t.Errorf("R4 no-ts: got %d, want 0", byReason["R4"].LastSeenUnix)
	}
}

// TestSummarizeEvents_InvolvedObjectFields checks kind/name mapping.
func TestSummarizeEvents_InvolvedObjectFields(t *testing.T) {
	e := makeEvent("Normal", "Scheduled", "scheduled", "kube-system", "Pod", "coredns-abc", 1, t100, t100)
	out := SummarizeEvents([]corev1.Event{e})
	if len(out) != 1 {
		t.Fatalf("want 1, got %d", len(out))
	}
	s := out[0]
	if s.Kind != "Pod" {
		t.Errorf("Kind: got %q, want Pod", s.Kind)
	}
	if s.Name != "coredns-abc" {
		t.Errorf("Name: got %q, want coredns-abc", s.Name)
	}
	if s.Namespace != "kube-system" {
		t.Errorf("Namespace: got %q, want kube-system", s.Namespace)
	}
}

// TestSummarizeEvents_Empty confirms no panic on empty input.
func TestSummarizeEvents_Empty(t *testing.T) {
	out := SummarizeEvents(nil)
	if out == nil {
		t.Fatal("want non-nil slice")
	}
	if len(out) != 0 {
		t.Fatalf("want 0, got %d", len(out))
	}
}
