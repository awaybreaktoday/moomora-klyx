package clock

import (
	"testing"
	"time"
)

func TestFakeClockAdvances(t *testing.T) {
	start := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	c := NewFake(start)
	if !c.Now().Equal(start) {
		t.Fatalf("want %v, got %v", start, c.Now())
	}
	c.Advance(90 * time.Second)
	if got := c.Now(); !got.Equal(start.Add(90 * time.Second)) {
		t.Fatalf("want +90s, got %v", got)
	}
}

func TestRealClockMovesForward(t *testing.T) {
	c := Real{}
	a := c.Now()
	b := c.Now()
	if b.Before(a) {
		t.Fatalf("real clock went backwards: %v then %v", a, b)
	}
}
