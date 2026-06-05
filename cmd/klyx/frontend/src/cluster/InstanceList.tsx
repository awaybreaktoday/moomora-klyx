import { useEffect } from "react";
import { useFleet, ResourceRef } from "../store/fleet";
import { loadInstances } from "../bridge/crd";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function age(created: string): string {
  if (!created) return "";
  const ms = Date.now() - Date.parse(created);
  if (Number.isNaN(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function InstanceList({ cluster, resource }: { cluster: string; resource: ResourceRef }) {
  const instances = useFleet((s) => s.instances);
  const setFilter = useFleet((s) => s.setInstanceFilter);

  useEffect(() => {
    void loadInstances(cluster, resource);
    return () => useFleet.getState().clearInstances();
  }, [cluster, resource.group, resource.version, resource.plural]);

  const namespaced = resource.scope === "Namespaced";
  const cols = namespaced ? "1fr 1.4fr 70px" : "1fr 70px";

  const isCurrent = instances.ref && instances.ref.group === resource.group && instances.ref.plural === resource.plural;
  const all = isCurrent ? instances.rows : [];
  const q = instances.filter.toLowerCase();
  const rows = all
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q))
    .sort((a, b) => (a.namespace === b.namespace ? a.name.localeCompare(b.name) : a.namespace.localeCompare(b.namespace)));

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{resource.kind}</div>
        <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 9, padding: "1px 6px", borderRadius: 3 }}>{resource.scope.toLowerCase()}</span>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{all.length} loaded</span>
        <div style={{ flex: 1 }} />
        <input
          value={instances.filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="name, namespace…"
          style={{ width: 200, height: 28, paddingLeft: 10, fontSize: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 4, color: "var(--color-text-primary)" }}
        />
      </div>

      {instances.loading && all.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading instances…</div>
      ) : all.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No instances of this kind.</div>
      ) : (
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, padding: "6px 12px", background: "var(--color-background-secondary)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>
            {namespaced && <span>namespace</span>}
            <span>name</span>
            <span>age</span>
          </div>
          {rows.map((r) => (
            <div key={`${r.namespace}/${r.name}`} style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11 }}>
              {namespaced && <span style={{ color: "var(--color-text-secondary)", ...ellipsis }}>{r.namespace}</span>}
              <span style={{ fontFamily: "var(--font-mono)", ...ellipsis }}>{r.name}</span>
              <span style={{ color: "var(--color-text-tertiary)" }}>{age(r.created)}</span>
            </div>
          ))}
        </div>
      )}

      {isCurrent && instances.nextToken && (
        <button
          onClick={() => void loadInstances(cluster, resource, instances.nextToken)}
          style={{ marginTop: 10, padding: "5px 12px", fontSize: 12, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}
        >
          Load more
        </button>
      )}
    </div>
  );
}
