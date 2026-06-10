import { useEffect } from "react";
import { useFleet, ResourceRef, crdCountKey } from "../store/fleet";
import { countKind } from "../bridge/crd";
import { BUILTIN_CATALOG } from "./builtins";
import { Chip } from "../chrome/Chip";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function matchesBuiltin(ref: ResourceRef, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return ref.kind.toLowerCase().includes(s) || ref.plural.toLowerCase().includes(s) || ref.group.toLowerCase().includes(s);
}

export function BuiltinsView({ cluster }: { cluster: string }) {
  const search = useFleet((s) => s.crd.search);
  const setSearch = useFleet((s) => s.setCRDSearch);
  const builtinCategory = useFleet((s) => s.crd.builtinCategory);
  const setBuiltinCategory = useFleet((s) => s.setBuiltinCategory);

  const categories = BUILTIN_CATALOG
    .filter((cat) => builtinCategory === null || cat.label === builtinCategory)
    .map((cat) => ({ ...cat, kinds: cat.kinds.filter((ref) => matchesBuiltin(ref, search)) }))
    .filter((cat) => cat.kinds.length > 0);

  const isEmpty = categories.length === 0;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Built-in resource catalog
        </div>
        <div style={{ flex: 1 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="kind, group…"
          style={{ width: 200, height: 28, paddingLeft: 10, fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
        />
      </div>

      {/* Category chip row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <Chip on={builtinCategory === null} onClick={() => setBuiltinCategory(null)}>all</Chip>
        {BUILTIN_CATALOG.map((cat) => (
          <Chip
            key={cat.label}
            on={builtinCategory === cat.label}
            onClick={() => setBuiltinCategory(builtinCategory === cat.label ? null : cat.label)}
          >
            {cat.label}
          </Chip>
        ))}
      </div>

      {isEmpty ? (
        <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>No built-in resources match your search.</div>
      ) : (
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
          {categories.map((cat) => (
            <BuiltinCategory key={cat.label} cluster={cluster} label={cat.label} kinds={cat.kinds} />
          ))}
        </div>
      )}
    </div>
  );
}

// BuiltinCategory renders one category row from the static builtin catalog,
// always expanded. Counts are loaded lazily via the same countKind bridge used
// by CRDBrowser, so the same concurrency cap and dedup apply.
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
