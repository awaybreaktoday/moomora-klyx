package routemetrics

import (
	"regexp"
	"testing"
)

func TestParseClusterName(t *testing.T) {
	cases := []struct {
		in      string
		wantKey string
		wantOK  bool
	}{
		{"httproute/default/web/rule/0", "default/web", true},
		{"httproute/team-a/api-gw/rule/12", "team-a/api-gw", true},
		{"httproute/default/web", "", false},          // no rule segment
		{"httproute/default/web/rule/foo", "", false}, // non-numeric rule
		{"httproute/default/web/rule/", "", false},    // empty rule idx
		{"httproute//web/rule/0", "", false},          // empty namespace
		{"cluster/default/web/rule/0", "", false},     // wrong prefix
		{"httproute/default/web/route/0", "", false},  // wrong segment
		{"", "", false},
	}
	for _, tc := range cases {
		k, ok := parseClusterName(tc.in)
		if ok != tc.wantOK || k != tc.wantKey {
			t.Fatalf("parseClusterName(%q) = (%q,%v), want (%q,%v)", tc.in, k, ok, tc.wantKey, tc.wantOK)
		}
	}
}

func TestBuildSelector(t *testing.T) {
	if got := buildSelector(nil); got != "" {
		t.Fatalf("empty keys should give empty selector, got %q", got)
	}
	sel := buildSelector([]string{"default/web", "team.a/api-gw"})
	// anchored, alternation, regex-escaped (the dot in "team.a" must be escaped;
	// "-" is not a regex metacharacter so QuoteMeta leaves it unescaped).
	want := `envoy_cluster_name=~"^httproute/(default/web|team\.a/api-gw)/rule/[0-9]+$"`
	if sel != want {
		t.Fatalf("buildSelector:\n got %s\nwant %s", sel, want)
	}
	// the alternation body is a valid regex.
	inner := `^httproute/(default/web|team\.a/api-gw)/rule/[0-9]+$`
	if _, err := regexp.Compile(inner); err != nil {
		t.Fatalf("selector regex does not compile: %v", err)
	}
}
