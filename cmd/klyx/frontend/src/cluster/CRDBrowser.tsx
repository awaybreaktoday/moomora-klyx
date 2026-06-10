import { useEffect } from "react";
import { useFleet, CRDGroupDTO, CRDKindDTO, CRDGroupBy, crdCountKey, ResourceRef } from "../store/fleet";
import { listCRDs, countKind } from "../bridge/crd";
import { BUILTIN_CATALOG } from "./builtins";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

type FlatKind = CRDKindDTO & { group: string; category: string };

function flatten(groups: CRDGroupDTO[]): FlatKind[] {
  return groups.flatMap((g) => g.kinds.map((k) => ({ ...k, group: g.group, category: g.category })));
}

// reshape turns the api-group groups into display sections per the groupBy mode.
function reshape(groups: CRDGroupDTO[], groupBy: CRDGroupBy): { label: string; category: string; kinds: FlatKind[] }[] {
  if (groupBy === "group") {
    return groups.map((g) => ({ label: g.group, category: g.category, kinds: g.kinds.map((k) => ({ ...k, group: g.group, category: g.category })) }));
  }
  const flat = flatten(groups);
  if (groupBy === "alphabetical") {
    return [{ label: "all kinds", category: "", kinds: [...flat].sort((a, b) => a.kind.localeCompare(b.kind)) }];
  }
  const keyOf = (k: FlatKind) => (groupBy === "scope" ? (k.scope || "unknown") : (k.operator || "unattributed"));
  const buckets = new Map<string, FlatKind[]>();
  for (const k of flat) {
    const key = keyOf(k);
    const arr = buckets.get(key) ?? [];
    arr.push(k);
    buckets.set(key, arr);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, kinds]) => ({ label, category: "", kinds: kinds.sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

function matches(k: FlatKind, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return k.kind.toLowerCase().includes(s) || k.group.toLowerCase().includes(s) || (k.operator ?? "").toLowerCase().includes(s);
}

function matchesBuiltin(ref: ResourceRef, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return ref.kind.toLowerCase().includes(s) || ref.plural.toLowerCase().includes(s) || ref.group.toLowerCase().includes(s);
}

const GROUP_BYS: CRDGroupBy[] = ["group", "operator", "scope", "alphabetical"];
const GROUP_BY_LABEL: Record<CRDGroupBy, string> = { group: "api group", operator: "operator", scope: "scope", alphabetical: "alphabetical" };

export function CRDBrowser({ cluster }: { cluster: string }) {
  const crd = useFleet((s) => s.crd);
  const setGroupBy = useFleet((s) => s.setCRDGroupBy);
  const setSearch = useFleet((s) => s.setCRDSearch);

  useEffect(() => {
    listCRDs(cluster).catch((e) => console.error("listCRDs", e));
    return () => useFleet.getState().clearCRDs();
  }, [cluster]);

  const groups = crd.cluster === cluster ? crd.groups : [];
  const sections = reshape(groups, crd.groupBy)
    .map((sec) => ({ ...sec, kinds: sec.kinds.filter((k) => matches(k, crd.search)) }))
    .filter((sec) => sec.kinds.length > 0);

  const totalKinds = flatten(groups).length;

  // Filter builtin catalog by search query
  const builtinCategories = BUILTIN_CATALOG
    .map((cat) => ({ ...cat, kinds: cat.kinds.filter((ref) => matchesBuiltin(ref, crd.search)) }))
    .filter((cat) => cat.kinds.length > 0);

  // Only block render when CRDs are loading AND builtins are also empty (e.g., filtered out).
  if (crd.loading && groups.length === 0 && builtinCategories.length === 0) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading custom resources…</div>;
  }
  if (groups.length === 0 && builtinCategories.length === 0) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>No custom resources found on this cluster.</div>;
  }

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          <b style={{ color: "var(--color-text-primary)" }}>{groups.length}</b> groups · <b style={{ color: "var(--color-text-primary)" }}>{totalKinds}</b> kinds
        </div>
        <div style={{ flex: 1 }} />
        <input
          value={crd.search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="kind, group, operator…"
          style={{ width: 200, height: 28, paddingLeft: 10, fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
        />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, fontSize: 11, alignItems: "center" }}>
        <span style={{ color: "var(--color-text-tertiary)" }}>group by:</span>
        {GROUP_BYS.map((g) => (
          <button
            key={g}
            onClick={() => setGroupBy(g)}
            style={{
              padding: "3px 9px", borderRadius: 999, cursor: "pointer", fontSize: 11,
              border: "0.5px solid var(--color-border-tertiary)",
              background: crd.groupBy === g ? "var(--color-background-info)" : "transparent",
              color: crd.groupBy === g ? "var(--color-text-info)" : "var(--color-text-secondary)",
            }}
          >
            {GROUP_BY_LABEL[g]}
          </button>
        ))}
      </div>

      {builtinCategories.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--color-text-tertiary)", marginBottom: 4, paddingLeft: 2 }}>
            Built-in
          </div>
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
            {builtinCategories.map((cat) => (
              <BuiltinCategory key={cat.label} cluster={cluster} label={cat.label} kinds={cat.kinds} />
            ))}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <>
          {!crd.search && (
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--color-text-tertiary)", marginBottom: 4, paddingLeft: 2 }}>
              Custom Resources
            </div>
          )}
          <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
            {sections.map((sec) => (
              <Section key={sec.label} cluster={cluster} label={sec.label} category={sec.category} kinds={sec.kinds} grouped={crd.groupBy === "group"} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// BuiltinCategory renders one category row from the static builtin catalog,
// always expanded. Counts are loaded lazily via the same countKind bridge used
// by CRD group sections, so the same concurrency cap and dedup apply.
function BuiltinCategory({ cluster, label, kinds }: { cluster: string; label: string; kinds: ResourceRef[] }) {
  const counts = useFleet((s) => s.crd.counts);
  const openResource = useFleet((s) => s.openResource);

  useEffect(() => {
    for (const ref of kinds) {
      if (!counts[crdCountKey(ref.group, ref.version, ref.plural)]) {
        void countKind(cluster, ref.group, ref.version, ref.plural);
      }
    }
  }, [cluster, kinds, counts]);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px", gap: 10, alignItems: "center", padding: "7px 12px", background: "var(--color-background-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <span />
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", ...ellipsis }}>{label}</div>
        <span />
        <span />
      </div>
      {kinds.map((ref) => {
        const c = counts[crdCountKey(ref.group, ref.version, ref.plural)];
        const display = c ? (c.capped ? `${c.count}+` : `${c.count}`) : "…";
        return (
          <div
            key={`builtin/${ref.group}/${ref.plural}`}
            onClick={() => openResource(ref)}
            style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px", gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, cursor: "pointer" }}
          >
            <span />
            <div style={{ fontFamily: "var(--font-mono)", ...ellipsis }}>{ref.kind}</div>
            <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 5px", borderRadius: 3, justifySelf: "start" }}>{ref.scope.toLowerCase()}</span>
            <span style={{ fontWeight: 500 }}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

function Section({ cluster, label, category, kinds, grouped }: { cluster: string; label: string; category: string; kinds: FlatKind[]; grouped: boolean }) {
  const expanded = useFleet((s) => s.crd.expanded);
  const counts = useFleet((s) => s.crd.counts);
  const toggle = useFleet((s) => s.toggleCRDGroup);
  const openResource = useFleet((s) => s.openResource);
  const open = !grouped || expanded.includes(label);

  // Re-firing on `counts` is safe and convergent: the `!counts[key]` guard skips
  // already-fetched kinds, and countKind's in-flight Set dedupes the window
  // before a count lands - so each kind is counted exactly once.
  useEffect(() => {
    if (!open) return;
    for (const k of kinds) {
      if (!counts[crdCountKey(k.group, k.version, k.plural)]) {
        void countKind(cluster, k.group, k.version, k.plural);
      }
    }
  }, [open, cluster, kinds, counts]);

  const sectionInstances = kinds.reduce((n, k) => n + (counts[crdCountKey(k.group, k.version, k.plural)]?.count ?? 0), 0);
  const sectionCounted = kinds.every((k) => counts[crdCountKey(k.group, k.version, k.plural)]);
  const sectionCapped = kinds.some((k) => counts[crdCountKey(k.group, k.version, k.plural)]?.capped);

  return (
    <div>
      <div
        onClick={() => grouped && toggle(label)}
        style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px 1fr", gap: 10, alignItems: "center", padding: "8px 12px", background: "var(--color-background-secondary)", cursor: grouped ? "pointer" : "default", borderTop: "0.5px solid var(--color-border-tertiary)" }}
      >
        <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>{grouped ? (open ? "▾" : "▸") : ""}</span>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, ...ellipsis }}>{label}</div>
        {category ? <span style={{ background: "var(--color-background-primary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 6px", borderRadius: 3, letterSpacing: 0.3, justifySelf: "start" }}>{category}</span> : <span />}
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{kinds.length} kinds</span>
        <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{sectionCounted ? `${sectionInstances}${sectionCapped ? "+" : ""} instances` : "…"}</span>
      </div>
      {open && kinds.map((k) => {
        const c = counts[crdCountKey(k.group, k.version, k.plural)];
        const display = c ? (c.capped ? `${c.count}+` : `${c.count}`) : "…";
        return (
          <div
            key={`${k.group}/${k.kind}`}
            onClick={() => openResource({ group: k.group, version: k.version, plural: k.plural, kind: k.kind, scope: k.scope })}
            style={{ display: "grid", gridTemplateColumns: "18px 1fr 90px 70px 1fr", gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, cursor: "pointer" }}
          >
            <span />
            <div style={{ fontFamily: "var(--font-mono)", ...ellipsis }}>{k.kind} {k.shortNames[0] && <span style={{ color: "var(--color-text-tertiary)" }}>{k.shortNames[0]}</span>}</div>
            <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 5px", borderRadius: 3, justifySelf: "start" }}>{k.scope.toLowerCase()}</span>
            <span style={{ fontWeight: 500 }}>{display}</span>
            <span style={{ color: "var(--color-text-tertiary)", ...ellipsis }}>{k.operator}</span>
          </div>
        );
      })}
    </div>
  );
}
