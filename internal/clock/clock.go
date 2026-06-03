// Package clock provides an injectable time source for deterministic tests.
package clock

import (
	"sync"
	"time"
)

// Clock is the minimal time source the data layer depends on.
type Clock interface {
	Now() time.Time
}

// Real is the production clock.
type Real struct{}

func (Real) Now() time.Time { return time.Now() }

// Fake is a controllable clock for tests.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

func NewFake(t time.Time) *Fake { return &Fake{now: t} }

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
