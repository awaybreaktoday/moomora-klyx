// Package config loads the Klyx-owned fleet configuration. Cluster identity,
// grouping, environment tags, and metrics endpoints are declared here;
// kubeconfig is used only to resolve credentials.
package config

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Clusters []ClusterConfig `yaml:"clusters"`
}

type ClusterConfig struct {
	Name        string            `yaml:"name"`
	Context     string            `yaml:"context"`
	Kubeconfig  string            `yaml:"kubeconfig"`
	Tags        map[string]string `yaml:"tags"`
	Group       string            `yaml:"group"`
	Environment string            `yaml:"environment"`
	Protected   bool              `yaml:"protected"`
	Metrics     *MetricsConfig    `yaml:"metrics"`
}

type MetricsConfig struct {
	Endpoint      string `yaml:"endpoint"`
	Token         string `yaml:"token"`
	TLSSkipVerify bool   `yaml:"tlsSkipVerify"`
}

// Env returns the environment tag, or "" if unset.
func (c ClusterConfig) Env() string { return c.Tags["env"] }

// reservedTagKeys are top-level ClusterConfig field names. If one shows up as a
// `tags:` key it is almost certainly a misplaced field: YAML silently accepts it
// into the Tags map, so the intended typed field stays at its zero value (the
// classic `tags: {protected: true}` trap, where Protected never gets set).
var reservedTagKeys = map[string]bool{
	"name": true, "context": true, "kubeconfig": true, "group": true,
	"environment": true, "protected": true, "metrics": true,
}

// Warnings returns non-fatal config problems worth surfacing at startup, chiefly
// tag keys that shadow a real cluster field. Deterministically ordered.
func (c *Config) Warnings() []string {
	var w []string
	for _, cl := range c.Clusters {
		shadowed := make([]string, 0, len(cl.Tags))
		for k := range cl.Tags {
			if reservedTagKeys[k] {
				shadowed = append(shadowed, k)
			}
		}
		sort.Strings(shadowed)
		for _, k := range shadowed {
			w = append(w, fmt.Sprintf("cluster %q: tag %q shadows a cluster field and is ignored; move it out of `tags:` to a top-level key", cl.Name, k))
		}
	}
	return w
}

// Summary is a one-line description of the loaded fleet for the startup log, so a
// misplaced `protected` shows up as an absence the operator can notice.
func (c *Config) Summary() string {
	protected := make([]string, 0)
	for _, cl := range c.Clusters {
		if cl.Protected {
			protected = append(protected, cl.Name)
		}
	}
	sort.Strings(protected)
	list := "none"
	if len(protected) > 0 {
		list = strings.Join(protected, ", ")
	}
	return fmt.Sprintf("fleet: %d cluster(s); protected: %s", len(c.Clusters), list)
}

// Load reads, parses, defaults, and validates a fleet config file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %q: %w", path, err)
	}
	var c Config
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse config %q: %w", path, err)
	}
	c.applyDefaults()
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("invalid config %q: %w", path, err)
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	for i := range c.Clusters {
		if c.Clusters[i].Context == "" {
			c.Clusters[i].Context = c.Clusters[i].Name
		}
	}
}

func (c *Config) validate() error {
	if len(c.Clusters) == 0 {
		return fmt.Errorf("no clusters configured")
	}
	seen := make(map[string]bool, len(c.Clusters))
	for i, cl := range c.Clusters {
		if cl.Name == "" {
			return fmt.Errorf("cluster[%d]: name is required", i)
		}
		if seen[cl.Name] {
			return fmt.Errorf("duplicate cluster name %q", cl.Name)
		}
		seen[cl.Name] = true
	}
	return nil
}
