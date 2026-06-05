package fleet

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/gwapi"
)

const gwGroup = "gateway.networking.k8s.io"

func (c *ClusterConn) gwGVR(resource string) schema.GroupVersionResource {
	v := preferredVersion(c.typed.Discovery(), gwGroup, "v1")
	return schema.GroupVersionResource{Group: gwGroup, Version: v, Resource: resource}
}

// gatewayAPIServed reports whether the Gateway API group is advertised.
func (c *ClusterConn) gatewayAPIServed() bool {
	groups, err := c.typed.Discovery().ServerGroups()
	if err != nil || groups == nil {
		return false
	}
	for _, g := range groups.Groups {
		if g.Name == gwGroup {
			return true
		}
	}
	return false
}

// ListGateways lists Gateways (refs) and whether the Gateway API is served.
func (c *ClusterConn) ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error) {
	served := c.gatewayAPIServed()
	list, err := c.dyn.Resource(c.gwGVR("gateways")).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, served, nil // not served / not installed → empty, no hard error
	}
	out := make([]gwapi.GatewayRef, 0, len(list.Items))
	for i := range list.Items {
		u := &unstructured.Unstructured{Object: list.Items[i].Object}
		out = append(out, gwapi.ParseGatewayRef(u))
	}
	return out, served, nil
}

// GetGatewayTopology builds the per-Gateway data path. A core failure (the Gateway
// cannot be read) returns an error; soft issues accumulate in Topology.Warnings.
func (c *ClusterConn) GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error) {
	gwu, err := c.dyn.Resource(c.gwGVR("gateways")).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return gwapi.Topology{}, fmt.Errorf("get gateway %s/%s: %w", namespace, name, err)
	}
	topo := gwapi.Topology{Gateway: gwapi.ParseGateway(gwu)}

	hrList, err := c.dyn.Resource(c.gwGVR("httproutes")).List(ctx, metav1.ListOptions{})
	if err != nil {
		topo.Warnings = append(topo.Warnings, "could not list HTTPRoutes: "+err.Error())
		return topo, nil
	}
	for i := range hrList.Items {
		u := &unstructured.Unstructured{Object: hrList.Items[i].Object}
		rn, ok := gwapi.RouteForGateway(u, namespace, name)
		if !ok {
			continue
		}
		c.resolveBackends(ctx, &rn, &topo)
		topo.Routes = append(topo.Routes, rn)
	}
	return topo, nil
}

// resolveBackends fills a route's Services + primary Pods from the typed client,
// appending warnings for anything it can't resolve.
func (c *ClusterConn) resolveBackends(ctx context.Context, rn *gwapi.RouteNode, topo *gwapi.Topology) {
	for i, b := range rn.Backends {
		if b.Kind != "Service" {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: backend %q is a %s, not a Service", rn.Namespace, rn.Name, b.Name, b.Kind))
			continue
		}
		sn := gwapi.ServiceNode{Namespace: b.Namespace, Name: b.Name, Port: b.Port}
		svc, err := c.typed.CoreV1().Services(b.Namespace).Get(ctx, b.Name, metav1.GetOptions{})
		if err != nil {
			topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: backend Service %s/%s not found", rn.Namespace, rn.Name, b.Namespace, b.Name))
			rn.Services = append(rn.Services, sn) // Resolved=false
			continue
		}
		sn.Resolved = true
		sn.Type = string(svc.Spec.Type)
		if len(svc.Spec.Ports) > 0 && sn.Port == 0 {
			sn.Port = svc.Spec.Ports[0].Port
		}
		rn.Services = append(rn.Services, sn)
		if i == 0 {
			rn.Pods = c.podCount(ctx, b.Namespace, b.Name, topo, rn)
		}
	}
	if len(rn.Backends) > 1 {
		topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s has %d backends; the lane shows the primary", rn.Namespace, rn.Name, len(rn.Backends)))
	}
}

func (c *ClusterConn) podCount(ctx context.Context, ns, svc string, topo *gwapi.Topology, rn *gwapi.RouteNode) gwapi.PodCount {
	slices, err := c.typed.DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{LabelSelector: "kubernetes.io/service-name=" + svc})
	if err != nil {
		topo.Warnings = append(topo.Warnings, fmt.Sprintf("route %s/%s: EndpointSlices unavailable for %s", rn.Namespace, rn.Name, svc))
		return gwapi.PodCount{Unknown: true}
	}
	pc := gwapi.PodCount{}
	for i := range slices.Items {
		for _, e := range slices.Items[i].Endpoints {
			pc.Total++
			if e.Conditions.Ready != nil && *e.Conditions.Ready {
				pc.Ready++
			}
		}
	}
	return pc
}
