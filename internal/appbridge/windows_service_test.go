package appbridge

import (
	"net/url"
	"strings"
	"testing"
)

// fakeOpener records the last OpenWindow call.
type fakeOpener struct {
	called bool
	title  string
	url    string
	width  int
	height int
}

func (f *fakeOpener) OpenWindow(title, u string, width, height int) {
	f.called = true
	f.title = title
	f.url = u
	f.width = width
	f.height = height
}

func TestOpenLogsWindow_BuildsURLAndTitle(t *testing.T) {
	op := &fakeOpener{}
	svc := NewWindowsService(op)

	res := svc.OpenLogsWindow("prod", "monitoring", "grafana-7d4", "grafana")
	if !res.OK {
		t.Fatalf("expected OK, got error %q", res.Error)
	}
	if !op.called {
		t.Fatal("opener was not called")
	}

	if op.title != "logs · monitoring/grafana-7d4" {
		t.Errorf("title = %q", op.title)
	}
	if op.width != logsWindowWidth || op.height != logsWindowHeight {
		t.Errorf("size = %dx%d, want %dx%d", op.width, op.height, logsWindowWidth, logsWindowHeight)
	}

	if !strings.HasPrefix(op.url, "/?") {
		t.Fatalf("url should start with /?, got %q", op.url)
	}
	q, err := url.ParseQuery(strings.TrimPrefix(op.url, "/?"))
	if err != nil {
		t.Fatalf("query parse: %v", err)
	}
	if q.Get("logswin") != "1" {
		t.Errorf("logswin = %q", q.Get("logswin"))
	}
	if q.Get("cluster") != "prod" {
		t.Errorf("cluster = %q", q.Get("cluster"))
	}
	if q.Get("ns") != "monitoring" {
		t.Errorf("ns = %q", q.Get("ns"))
	}
	if q.Get("pod") != "grafana-7d4" {
		t.Errorf("pod = %q", q.Get("pod"))
	}
	if q.Get("container") != "grafana" {
		t.Errorf("container = %q", q.Get("container"))
	}
}

func TestOpenLogsWindow_EncodesSpecialChars(t *testing.T) {
	op := &fakeOpener{}
	svc := NewWindowsService(op)

	// Cluster names with spaces/specials, container with ampersand.
	res := svc.OpenLogsWindow("west europe/prd", "kube system", "pod a&b", "c d")
	if !res.OK {
		t.Fatalf("expected OK, got %q", res.Error)
	}

	// Raw URL must not contain a literal space; it must be percent-encoded.
	if strings.Contains(op.url, " ") {
		t.Errorf("url contains raw space: %q", op.url)
	}

	// Round-trip the query: decoded values must equal the originals.
	q, err := url.ParseQuery(strings.TrimPrefix(op.url, "/?"))
	if err != nil {
		t.Fatalf("query parse: %v", err)
	}
	if q.Get("cluster") != "west europe/prd" {
		t.Errorf("cluster decoded = %q", q.Get("cluster"))
	}
	if q.Get("ns") != "kube system" {
		t.Errorf("ns decoded = %q", q.Get("ns"))
	}
	if q.Get("pod") != "pod a&b" {
		t.Errorf("pod decoded = %q", q.Get("pod"))
	}
	if q.Get("container") != "c d" {
		t.Errorf("container decoded = %q", q.Get("container"))
	}
}

func TestOpenLogsWindow_AllowsEmptyContainer(t *testing.T) {
	op := &fakeOpener{}
	svc := NewWindowsService(op)

	res := svc.OpenLogsWindow("prod", "default", "web-1", "")
	if !res.OK {
		t.Fatalf("expected OK with empty container, got %q", res.Error)
	}
	q, _ := url.ParseQuery(strings.TrimPrefix(op.url, "/?"))
	if q.Get("container") != "" {
		t.Errorf("container should be empty, got %q", q.Get("container"))
	}
}

func TestOpenLogsWindow_Validation(t *testing.T) {
	cases := []struct {
		name                     string
		cluster, ns, pod, contnr string
	}{
		{"empty cluster", "", "ns", "pod", "c"},
		{"empty namespace", "cl", "", "pod", "c"},
		{"empty pod", "cl", "ns", "", "c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := &fakeOpener{}
			svc := NewWindowsService(op)
			res := svc.OpenLogsWindow(tc.cluster, tc.ns, tc.pod, tc.contnr)
			if res.OK {
				t.Fatal("expected validation error, got OK")
			}
			if res.Error == "" {
				t.Fatal("expected non-empty error message")
			}
			if op.called {
				t.Error("opener must not be called on validation failure")
			}
		})
	}
}

func TestOpenWorkloadLogsWindow(t *testing.T) {
	op := &fakeOpener{}
	svc := NewWindowsService(op)
	res := svc.OpenWorkloadLogsWindow("homelab", "team a", "Deployment", "web", "app")
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if op.title != "logs · team a/web (deployment)" {
		t.Errorf("title: got %q", op.title)
	}
	u, err := url.Parse(op.url)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	for k, want := range map[string]string{
		"logswin": "1", "mode": "workload", "cluster": "homelab",
		"ns": "team a", "kind": "Deployment", "name": "web", "container": "app",
	} {
		if got := q.Get(k); got != want {
			t.Errorf("param %s: got %q want %q", k, got, want)
		}
	}
}

func TestOpenWorkloadLogsWindow_Validation(t *testing.T) {
	op := &fakeOpener{}
	svc := NewWindowsService(op)
	for _, args := range [][4]string{
		{"", "ns", "Deployment", "web"},
		{"cl", "", "Deployment", "web"},
		{"cl", "ns", "", "web"},
		{"cl", "ns", "Deployment", ""},
	} {
		res := svc.OpenWorkloadLogsWindow(args[0], args[1], args[2], args[3], "")
		if res.OK {
			t.Fatalf("expected validation error for %v, got OK", args)
		}
	}
	if op.called {
		t.Error("opener must not be called on validation failure")
	}
}
