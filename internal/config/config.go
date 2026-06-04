// Package config loads the Klyx-owned fleet configuration. Cluster identity,
// grouping, environment tags, and metrics endpoints are declared here;
// kubeconfig is used only to resolve credentials.
package config

import (
	"fmt"
	"os"

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
