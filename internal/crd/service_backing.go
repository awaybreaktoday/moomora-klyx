package crd

import (
	"sort"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
)

// ServicePort is one port entry from a Service's spec.ports.
type ServicePort struct {
	Name     string
	Port     int32
	Protocol string
}

// EndpointAddr is one address entry from the EndpointSlices for a service.
// Ready follows the EndpointSlice Conditions.Ready convention: a nil pointer
// means ready (the API treats nil as "ready" per the EndpointSlice spec).
type EndpointAddr struct {
	IP         string
	Ready      bool
	TargetKind string // from TargetRef (typically "Pod")
	TargetName string
}

// ServiceBacking aggregates the backing endpoint health for a Service.
type ServiceBacking struct {
	Ports     []ServicePort
	Ready     int
	NotReady  int
	Addresses []EndpointAddr // capped at 50, ready first
	Selector  map[string]string
}

const maxEndpointAddrs = 50

// BuildServiceBacking assembles a ServiceBacking from a typed Service and its
// associated EndpointSlices. Ready and NotReady counts are summed across all
// slices. Addresses are capped at maxEndpointAddrs with ready addresses first.
//
// Per the EndpointSlice API, a nil Conditions.Ready means the endpoint IS ready
// (the absence of a condition is treated as "ready" by the API; explicit false
// is required to mark not-ready). This is faithfully reflected here.
func BuildServiceBacking(svc *corev1.Service, slices []discoveryv1.EndpointSlice) ServiceBacking {
	b := ServiceBacking{
		Selector: svc.Spec.Selector,
	}

	// Map spec.ports.
	for _, p := range svc.Spec.Ports {
		b.Ports = append(b.Ports, ServicePort{
			Name:     p.Name,
			Port:     p.Port,
			Protocol: string(p.Protocol),
		})
	}

	// Collect all addresses across all slices; count ready/not-ready.
	var readyAddrs, notReadyAddrs []EndpointAddr
	for _, sl := range slices {
		for _, ep := range sl.Endpoints {
			// nil Conditions.Ready means ready (EndpointSlice API convention).
			isReady := ep.Conditions.Ready == nil || *ep.Conditions.Ready

			kind, name := "", ""
			if ep.TargetRef != nil {
				kind = ep.TargetRef.Kind
				name = ep.TargetRef.Name
			}

			for _, addr := range ep.Addresses {
				ea := EndpointAddr{
					IP:         addr,
					Ready:      isReady,
					TargetKind: kind,
					TargetName: name,
				}
				if isReady {
					b.Ready++
					readyAddrs = append(readyAddrs, ea)
				} else {
					b.NotReady++
					notReadyAddrs = append(notReadyAddrs, ea)
				}
			}
		}
	}

	// Stable sort within each group so the output is deterministic.
	sort.Slice(readyAddrs, func(i, j int) bool { return readyAddrs[i].IP < readyAddrs[j].IP })
	sort.Slice(notReadyAddrs, func(i, j int) bool { return notReadyAddrs[i].IP < notReadyAddrs[j].IP })

	// Merge: ready first, then not-ready; cap at maxEndpointAddrs.
	merged := append(readyAddrs, notReadyAddrs...)
	if len(merged) > maxEndpointAddrs {
		merged = merged[:maxEndpointAddrs]
	}
	b.Addresses = merged

	return b
}
