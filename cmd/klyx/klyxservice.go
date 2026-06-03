package main

// KlyxService is the trivial bound service that proves the Go<->JS round-trip.
// Later tasks will replace this with the real FleetService.
type KlyxService struct{}

// Ping returns a simple string so the frontend can confirm the IPC bridge works.
func (k *KlyxService) Ping() string {
	return "pong from Klyx"
}
