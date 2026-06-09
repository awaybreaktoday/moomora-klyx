import { describe, it, expect } from "vitest";
import { BUILTIN_CATALOG } from "./builtins";

describe("BUILTIN_CATALOG sanity", () => {
  const allKinds = BUILTIN_CATALOG.flatMap((cat) => cat.kinds.map((ref) => ({ ...ref, cat: cat.label })));

  it("every entry has kind, plural, version, group, and scope", () => {
    for (const ref of allKinds) {
      expect(ref.kind, `${ref.cat} entry missing kind`).toBeTruthy();
      expect(ref.plural, `${ref.kind} missing plural`).toBeTruthy();
      expect(ref.version, `${ref.kind} missing version`).toBeTruthy();
      // group may be "" for core group - just check it is defined
      expect(ref.group, `${ref.kind} group is undefined`).toBeDefined();
      expect(ref.scope, `${ref.kind} missing scope`).toBeTruthy();
    }
  });

  it("scope is Namespaced or Cluster for every entry", () => {
    for (const ref of allKinds) {
      expect(["Namespaced", "Cluster"], `${ref.kind} has bad scope "${ref.scope}"`).toContain(ref.scope);
    }
  });

  it("no duplicate plural within the same group", () => {
    const seen = new Map<string, string>();
    for (const ref of allKinds) {
      const key = `${ref.group}/${ref.plural}`;
      const prev = seen.get(key);
      expect(prev, `duplicate: ${key} (${prev} and ${ref.kind})`).toBeUndefined();
      seen.set(key, ref.kind);
    }
  });

  it("has at least one entry per category", () => {
    for (const cat of BUILTIN_CATALOG) {
      expect(cat.kinds.length, `category "${cat.label}" has no kinds`).toBeGreaterThan(0);
    }
  });

  it("catalog has exactly 6 categories", () => {
    expect(BUILTIN_CATALOG.length).toBe(6);
  });

  it("Cluster-scoped resources have the right plurals", () => {
    const clusterScoped = allKinds.filter((r) => r.scope === "Cluster").map((r) => r.plural);
    expect(clusterScoped).toContain("namespaces");
    expect(clusterScoped).toContain("nodes");
    expect(clusterScoped).toContain("persistentvolumes");
    expect(clusterScoped).toContain("storageclasses");
    expect(clusterScoped).toContain("clusterroles");
    expect(clusterScoped).toContain("clusterrolebindings");
  });
});
