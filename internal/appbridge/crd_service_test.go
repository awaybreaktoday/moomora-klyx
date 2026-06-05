package appbridge

import (
	"context"
	"testing"

	"github.com/moomora/klyx/internal/crd"
)

type fakeCRDConn struct {
	infos  []crd.Info
	counts map[string]int
}

func (f *fakeCRDConn) ListCRDs(ctx context.Context) ([]crd.Info, error) { return f.infos, nil }
func (f *fakeCRDConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	n, ok := f.counts[plural]
	if !ok {
		return 0, false, nil
	}
	return n, n >= crd.Cap, nil
}

func TestListCRDsGroupsAndAttributes(t *testing.T) {
	conn := &fakeCRDConn{infos: []crd.Info{
		{Group: "cilium.io", Kind: "CiliumNode", Plural: "ciliumnodes", Scope: "Cluster", Version: "v2", Operator: "cilium"},
		{Group: "cilium.io", Kind: "CiliumEndpoint", Plural: "ciliumendpoints", Scope: "Namespaced", Version: "v2", Operator: "cilium"},
		{Group: "cert-manager.io", Kind: "Certificate", Plural: "certificates", Scope: "Namespaced", Version: "v1", Operator: "cert-manager"},
	}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	groups := svc.ListCRDs("x")
	if len(groups) != 2 {
		t.Fatalf("want 2 groups, got %d", len(groups))
	}
	if groups[0].Group != "cert-manager.io" || groups[1].Group != "cilium.io" {
		t.Fatalf("group order: %s, %s", groups[0].Group, groups[1].Group)
	}
	if groups[1].Category != "CNI" {
		t.Fatalf("cilium category: %q", groups[1].Category)
	}
	if groups[1].Kinds[0].Kind != "CiliumEndpoint" || groups[1].Kinds[1].Kind != "CiliumNode" {
		t.Fatalf("kind order: %+v", groups[1].Kinds)
	}
}

func TestListCRDsUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if g := svc.ListCRDs("ghost"); len(g) != 0 {
		t.Fatalf("want empty, got %d", len(g))
	}
}

func TestCountKind(t *testing.T) {
	conn := &fakeCRDConn{counts: map[string]int{"ciliumendpoints": crd.Cap, "certificates": 4}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	if c := svc.CountKind("x", "cilium.io", "v2", "ciliumendpoints"); c.Count != crd.Cap || !c.Capped {
		t.Fatalf("capped: %+v", c)
	}
	if c := svc.CountKind("x", "cert-manager.io", "v1", "certificates"); c.Count != 4 || c.Capped {
		t.Fatalf("exact: %+v", c)
	}
}
