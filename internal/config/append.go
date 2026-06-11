package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AppendClusters adds minimal cluster entries (name = context) to the fleet
// file by TEXTUAL append: the existing bytes - including comments and hand
// formatting - are preserved verbatim, and new `- name:` items are appended
// under the existing top-level `clusters:` list. A missing file is created
// with a small header. The candidate result is parsed and validated BEFORE the
// file is replaced, so a bad append can never corrupt a working config.
func AppendClusters(path string, contexts []string) error {
	if len(contexts) == 0 {
		return fmt.Errorf("no contexts to add")
	}

	original, readErr := os.ReadFile(path)
	exists := readErr == nil
	if readErr != nil && !os.IsNotExist(readErr) {
		return fmt.Errorf("read fleet config %q: %w", path, readErr)
	}

	// Refuse duplicates against the CURRENT file state (not the in-memory
	// startup config) so two adds in one session behave.
	if exists {
		cur, err := Load(path)
		if err != nil {
			return fmt.Errorf("existing fleet config is invalid; fix it before adding clusters: %w", err)
		}
		inFleet := map[string]bool{}
		for _, c := range cur.Clusters {
			inFleet[c.Name] = true
			inFleet[c.Context] = true
		}
		for _, ctx := range contexts {
			if inFleet[ctx] {
				return fmt.Errorf("context %q is already in the fleet", ctx)
			}
		}
	}

	var b strings.Builder
	if exists {
		b.Write(original)
		if len(original) > 0 && original[len(original)-1] != '\n' {
			b.WriteByte('\n')
		}
		// The file must already carry a top-level clusters: list for a plain
		// item append to land in the right place.
		if !strings.Contains(string(original), "clusters:") {
			return fmt.Errorf("fleet config %q has no top-level clusters: list", path)
		}
	} else {
		b.WriteString("# Klyx fleet configuration - clusters Klyx connects to.\n")
		b.WriteString("# Docs: each entry needs a name; context defaults to the name.\n")
		b.WriteString("clusters:\n")
	}
	for _, ctx := range contexts {
		fmt.Fprintf(&b, "  - name: %s\n", yamlScalar(ctx))
		fmt.Fprintf(&b, "    context: %s\n", yamlScalar(ctx))
	}
	candidate := b.String()

	// Validate the candidate by round-tripping it through the real loader.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".fleet-*.yaml")
	if err != nil {
		// Directory may not exist yet for the create-new path.
		if mkErr := os.MkdirAll(filepath.Dir(path), 0o755); mkErr != nil {
			return fmt.Errorf("create config directory: %w", mkErr)
		}
		tmp, err = os.CreateTemp(filepath.Dir(path), ".fleet-*.yaml")
		if err != nil {
			return fmt.Errorf("create temp config: %w", err)
		}
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.WriteString(candidate); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp config: %w", err)
	}
	if _, err := Load(tmpPath); err != nil {
		return fmt.Errorf("appended config failed validation (file unchanged): %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace fleet config: %w", err)
	}
	return nil
}

// yamlScalar quotes a value when it contains characters that would change its
// YAML meaning; kube context names like user@cluster are safe bare, but quote
// defensively for anything beyond the common shape.
func yamlScalar(s string) string {
	if strings.ContainsAny(s, ":#{}[]&*!|>'\"%@`, ") && !isSafeContext(s) {
		return fmt.Sprintf("%q", s)
	}
	return s
}

// isSafeContext allows the very common user@cluster shape without quotes.
func isSafeContext(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '.' || r == '_' || r == '@' || r == '/':
		default:
			return false
		}
	}
	return true
}
