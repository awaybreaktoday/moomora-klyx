package appbridge

import (
	"context"
	"sort"
	"time"

	"github.com/moomora/klyx/internal/workloads"
)

const eventsTimeout = 30 * time.Second

// EventsConn is the per-cluster read surface EventsService needs.
type EventsConn interface {
	ListEvents(ctx context.Context, namespace string) ([]workloads.EventSummary, error)
}

// EventsService is bound to JS. ListEvents returns warning-first event rows for
// a cluster, optionally scoped to a namespace.
type EventsService struct {
	lookup func(string) (EventsConn, bool)
}

// NewEventsService creates an EventsService with the given cluster-lookup function.
func NewEventsService(lookup func(string) (EventsConn, bool)) *EventsService {
	return &EventsService{lookup: lookup}
}

// ListEvents returns warning-first event rows for a cluster, scoped to namespace
// ("" = all). Namespaces is the sorted distinct set of event namespaces,
// populated ONLY on the all-namespaces load (dropdown source). Cluster miss
// returns non-nil empties (never panics on null).
func (s *EventsService) ListEvents(cluster, namespace string) EventsResultDTO {
	out := EventsResultDTO{Namespaces: []string{}, Events: []EventRowDTO{}}
	conn, ok := s.lookup(cluster)
	if !ok {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), eventsTimeout)
	defer cancel()

	events, err := conn.ListEvents(ctx, namespace)
	if err != nil {
		return out
	}

	nsSet := map[string]bool{}
	for _, e := range events {
		nsSet[e.Namespace] = true
		out.Events = append(out.Events, toEventRowDTO(e))
	}
	if namespace == "" {
		for ns := range nsSet {
			out.Namespaces = append(out.Namespaces, ns)
		}
		sort.Strings(out.Namespaces)
	}
	return out
}

func toEventRowDTO(e workloads.EventSummary) EventRowDTO {
	return EventRowDTO{
		Type:          e.Type,
		Reason:        e.Reason,
		Message:       e.Message,
		Count:         e.Count,
		Namespace:     e.Namespace,
		Kind:          e.Kind,
		Name:          e.Name,
		LastSeenUnix:  e.LastSeenUnix,
		FirstSeenUnix: e.FirstSeenUnix,
	}
}
