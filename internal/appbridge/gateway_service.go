package appbridge

import (
	"context"
	"time"

	"github.com/moomora/klyx/internal/gwapi"
)

type GatewayConn interface {
	ListGateways(ctx context.Context) ([]gwapi.GatewayRef, bool, error)
	GetGatewayTopology(ctx context.Context, namespace, name string) (gwapi.Topology, error)
}

const gatewayTimeout = 30 * time.Second

type GatewayService struct {
	lookup      func(string) (GatewayConn, bool)
	globalReach func(cluster, ns, name string) (peers []string, unconfirmed bool)
}

func NewGatewayService(lookup func(string) (GatewayConn, bool)) *GatewayService {
	return &GatewayService{lookup: lookup}
}

// SetGlobalReach wires the fleet cross-reference used to fill global services'
// meshClusters / meshUnconfirmed. Optional - without it, global services still
// render (just without the confirmed-peer list).
func (s *GatewayService) SetGlobalReach(f func(cluster, ns, name string) ([]string, bool)) {
	s.globalReach = f
}

func (s *GatewayService) ListGateways(cluster string) GatewayListDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return GatewayListDTO{Gateways: []GatewayRefDTO{}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTimeout)
	defer cancel()
	refs, served, err := conn.ListGateways(ctx)
	if err != nil {
		return GatewayListDTO{Gateways: []GatewayRefDTO{}}
	}
	out := GatewayListDTO{GatewayAPIServed: served, Gateways: make([]GatewayRefDTO, 0, len(refs))}
	for _, r := range refs {
		out.Gateways = append(out.Gateways, GatewayRefDTO{Namespace: r.Namespace, Name: r.Name, ClassName: r.ClassName, Accepted: r.Accepted, Programmed: r.Programmed})
	}
	return out
}

func (s *GatewayService) GetGatewayTopology(cluster, namespace, name string) TopologyDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return TopologyDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTimeout)
	defer cancel()
	topo, err := conn.GetGatewayTopology(ctx, namespace, name)
	if err != nil {
		return TopologyDTO{Error: err.Error()}
	}
	dto := toTopologyDTO(topo)
	if s.globalReach != nil {
		for ri := range dto.Routes {
			for si := range dto.Routes[ri].Services {
				sn := &dto.Routes[ri].Services[si]
				if sn.Global {
					peers, unconfirmed := s.globalReach(cluster, sn.Namespace, sn.Name)
					sn.MeshClusters = peers
					sn.MeshUnconfirmed = unconfirmed
				}
			}
		}
	}
	return dto
}
