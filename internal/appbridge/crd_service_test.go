package appbridge

import (
	"context"
	"testing"
	"time"

	"github.com/moomora/klyx/internal/crd"
)

type fakeCRDConn struct {
	infos     []crd.Info
	counts    map[string]int
	instances []crd.InstanceMeta
	nextToken string
	detail    crd.InstanceDetail
}

func (f *fakeCRDConn) ListCRDs(ctx context.Context) ([]crd.Info, error) { return f.infos, nil }
func (f *fakeCRDConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	n, ok := f.counts[plural]
	if !ok {
		return 0, false, nil
	}
	return n, n >= crd.Cap, nil
}
func (f *fakeCRDConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	return f.instances, f.nextToken, nil
}
func (f *fakeCRDConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	return f.detail, nil
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

func TestListInstancesMapsDTO(t *testing.T) {
	created := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	conn := &fakeCRDConn{
		instances: []crd.InstanceMeta{
			{Namespace: "team-a", Name: "w1", Created: created},
			{Namespace: "", Name: "cluster-scoped", Created: time.Time{}},
		},
		nextToken: "tok-2",
	}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	page := svc.ListInstances("x", "example.com", "v1", "widgets", "")
	if page.NextToken != "tok-2" {
		t.Fatalf("nextToken: %q", page.NextToken)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items: %d", len(page.Items))
	}
	if page.Items[0].Created != "2026-06-01T09:00:00Z" {
		t.Fatalf("created RFC3339: %q", page.Items[0].Created)
	}
	if page.Items[1].Created != "" {
		t.Fatalf("zero time must map to empty string, got %q", page.Items[1].Created)
	}
}

func TestListInstancesUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if p := svc.ListInstances("ghost", "g", "v", "p", ""); len(p.Items) != 0 || p.NextToken != "" {
		t.Fatalf("want empty page, got %+v", p)
	}
}

func TestGetInstanceDetailMapsDTO(t *testing.T) {
	created := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	last := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	conn := &fakeCRDConn{detail: crd.InstanceDetail{
		Kind: "Widget", Namespace: "team-a", Name: "w1", Created: created,
		Labels:     map[string]string{"app": "w"},
		Conditions: []crd.Condition{{Type: "Ready", Status: "True", Reason: "OK", Message: "ready"}},
		Events:     []crd.Event{{Type: "Warning", Reason: "Failed", Message: "boom", Count: 2, Last: last}},
		YAML:       "kind: Widget\n",
	}}
	svc := NewCRDService(func(string) (CRDConn, bool) { return conn, true })

	d := svc.GetInstanceDetail("x", "example.com", "v1", "widgets", "team-a", "w1")
	if d.Kind != "Widget" || d.Created != "2026-06-01T09:00:00Z" {
		t.Fatalf("header: %+v", d)
	}
	if len(d.Conditions) != 1 || d.Conditions[0].Type != "Ready" {
		t.Fatalf("conditions: %+v", d.Conditions)
	}
	if len(d.Events) != 1 || d.Events[0].Count != 2 || d.Events[0].LastSeen != "2026-06-02T10:00:00Z" {
		t.Fatalf("events: %+v", d.Events)
	}
	if d.YAML != "kind: Widget\n" || d.Labels["app"] != "w" {
		t.Fatalf("yaml/labels: %+v", d)
	}
}

func TestGetInstanceDetailUnknownClusterEmpty(t *testing.T) {
	svc := NewCRDService(func(string) (CRDConn, bool) { return nil, false })
	if d := svc.GetInstanceDetail("ghost", "g", "v", "p", "n", "x"); d.Kind != "" || len(d.Conditions) != 0 {
		t.Fatalf("want empty, got %+v", d)
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
