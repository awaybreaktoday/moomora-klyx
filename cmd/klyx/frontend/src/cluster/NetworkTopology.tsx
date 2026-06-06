import { useEffect, useState } from "react";
import { useFleet, GatewayRef, RouteNodeDTO } from "../store/fleet";
import { getGatewayTopology } from "../bridge/gateway";
import { PolicyChip } from "./PolicyChip";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const nb: React.CSSProperties = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "8px 9px", minWidth: 0 };
const lab: React.CSSProperties = { fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: 3 };
const nm: React.CSSProperties = { fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", ...ellipsis };
const chev: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-tertiary)" };

const routeKey = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;
const dot = (ok: boolean) => (ok ? "var(--color-text-success)" : "var(--color-text-danger)");

// Above this many namespaces the inline chips would wrap into a wall and shove
// the lanes off-screen, so we fall back to a native <select>. A proper
// searchable combobox primitive replaces this select in a later slice.
const NS_CHIP_LIMIT = 8;

export function NetworkTopology({ cluster, gateway }: { cluster: string; gateway: GatewayRef }) {
  const net = useFleet((s) => s.network);
  const selectRoute = useFleet((s) => s.selectRoute);
  const [nsFilter, setNsFilter] = useState<string | null>(null);

  useEffect(() => {
    void getGatewayTopology(cluster, gateway);
    return () => useFleet.getState().clearNetwork();
  }, [cluster, gateway.namespace, gateway.name]);

  const isCurrent = net.selected && net.selected.namespace === gateway.namespace && net.selected.name === gateway.name;
  const t = isCurrent ? net.topology : null;

  if (net.topologyLoading && !t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading topology…</div>;
  if (!t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Could not load the topology.</div>;

  // Namespace filter: a busy shared Gateway aggregates HTTPRoutes from many app
  // namespaces. The filter is opt-in (default "All" = the full data path) and only
  // appears when routes actually span more than one namespace.
  const nsCounts = new Map<string, number>();
  for (const r of t.routes) nsCounts.set(r.namespace, (nsCounts.get(r.namespace) ?? 0) + 1);
  const namespaces = [...nsCounts.keys()].sort();
  const showFilter = namespaces.length > 1;
  const activeNs = showFilter && nsFilter && nsCounts.has(nsFilter) ? nsFilter : null;
  const visibleRoutes = activeNs ? t.routes.filter((r) => r.namespace === activeNs) : t.routes;

  const selected = visibleRoutes.find((r) => routeKey(r) === net.selectedRoute) ?? null;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{t.gateway.name}</div>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: t.gateway.programmed ? "var(--color-background-success)" : "var(--color-background-warning)", color: t.gateway.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }}>{t.gateway.programmed ? "programmed" : "pending"}</span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t.gateway.className}</span>
        {t.gateway.policies.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--color-text-tertiary)" }}>policies</span>
            {t.gateway.policies.map((p) => (
              <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
            ))}
          </div>
        )}
        {t.clusterPolicies && t.clusterPolicies.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--color-text-tertiary)" }}>cluster-wide policies</span>
            {t.clusterPolicies.map((p) => (
              <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
            ))}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => void getGatewayTopology(cluster, gateway)} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>Refresh</button>
      </div>

      {t.error && (
        <div style={{ marginBottom: 12, padding: "8px 10px", fontSize: 12, borderRadius: 4, background: "var(--color-background-danger)", color: "var(--color-text-danger)", border: "0.5px solid var(--color-border-danger)" }}>{t.error}</div>
      )}

      {showFilter && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, alignItems: "center" }}>
          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--color-text-tertiary)", marginRight: 2 }}>namespace</span>
          {namespaces.length <= NS_CHIP_LIMIT ? (
            <>
              <Chip label="All" active={activeNs === null} onClick={() => setNsFilter(null)} />
              {namespaces.map((ns) => (
                <Chip key={ns} label={ns} count={nsCounts.get(ns)} active={activeNs === ns} onClick={() => setNsFilter(ns)} />
              ))}
            </>
          ) : (
            <select
              value={activeNs ?? ""}
              onChange={(e) => setNsFilter(e.target.value || null)}
              style={{ fontSize: 12, fontFamily: "var(--font-mono)", padding: "3px 8px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", maxWidth: 280 }}
            >
              <option value="">All namespaces ({t.routes.length})</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns} ({nsCounts.get(ns)})</option>
              ))}
            </select>
          )}
        </div>
      )}

      {t.routes.length === 0 && !t.error ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No HTTPRoutes attached to this Gateway.</div>
      ) : (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "14px 12px" }}>
          {visibleRoutes.map((r) => {
            const svc = r.services[0];
            return (
              <div key={routeKey(r)} style={{ display: "grid", gridTemplateColumns: "170px 20px 1fr 20px 200px 20px 104px", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
                <div style={nb}>
                  <div style={lab}>gateway</div><div style={nm}>{t.gateway.namespace}/{t.gateway.name}</div>
                  <div style={{ fontSize: 9, color: "var(--color-text-secondary)", marginTop: 2 }}>{t.gateway.listeners.map((l) => `${l.protocol}:${l.port}`).join(" · ")}</div>
                </div>
                <div style={chev}>›</div>
                <div style={{ ...nb, borderColor: "var(--color-border-info)", cursor: "pointer", boxShadow: net.selectedRoute === routeKey(r) ? "0 0 0 1px var(--color-text-info)" : undefined }} onClick={() => selectRoute(routeKey(r))}>
                  <div style={{ ...lab, color: "var(--color-text-info)" }}>httproute</div>
                  <div style={{ ...nm, color: "var(--color-text-info)" }}>{r.name}</div>
                  <div style={{ fontSize: 9, marginTop: 2, ...ellipsis }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: dot(r.accepted), display: "inline-block", marginRight: 4 }} />{r.accepted ? "accepted" : "rejected"} · {r.matches[0]?.pathValue ?? "/"}</div>
                  {r.policies.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {r.policies.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>service</div>
                  <div style={nm}>{svc ? svc.name : "—"}</div>
                  <div style={{ fontSize: 9, color: svc?.resolved ? "var(--color-text-secondary)" : "var(--color-text-danger)", marginTop: 2 }}>{!svc ? "no backend" : svc.resolved ? `${svc.type} :${svc.port}` : "unresolved"}{r.backends.length > 1 ? ` · +${r.backends.length - 1}` : ""}</div>
                  {svc && svc.policies.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {svc.policies.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>pods</div>
                  <div style={nm}>{r.pods.unknown ? "unknown" : `${r.pods.ready} / ${r.pods.total}`}</div>
                  {svc && svc.cnps.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                      {svc.cnps.map((p) => (
                        <PolicyChip key={`${p.kind}/${p.namespace}/${p.name}`} p={p} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-secondary)", fontSize: 10, color: "var(--color-text-tertiary)" }}>⬡ ClusterMesh: not shown yet (arrives in a later slice)</div>
        </div>
      )}

      {t.warnings && t.warnings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {t.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--color-text-warning)", padding: "2px 0" }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {selected && <RouteDetail route={selected} />}
    </div>
  );
}

function Chip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 9px",
        fontSize: 11,
        borderRadius: 999,
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        border: active ? "0.5px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
        background: active ? "var(--color-background-info)" : "var(--color-background-primary)",
        color: active ? "var(--color-text-info)" : "var(--color-text-secondary)",
      }}
    >
      {label}
      {count !== undefined && <span style={{ fontSize: 9, opacity: 0.7 }}>{count}</span>}
    </button>
  );
}

function RouteDetail({ route }: { route: RouteNodeDTO }) {
  return (
    <div style={{ marginTop: 12, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "10px 12px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: "var(--color-text-info)" }}>↳</span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12 }}>{route.name}</span>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--color-background-secondary)", color: "var(--color-text-secondary)" }}>HTTPRoute</span>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: route.accepted ? "var(--color-background-success)" : "var(--color-background-danger)", color: route.accepted ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{route.accepted ? "accepted" : "rejected"} · {route.resolvedRefs ? "resolvedRefs" : "unresolved"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11, fontFamily: "var(--font-mono)" }}>
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 5 }}>matches</div>
          {route.matches.map((m, i) => (<div key={i}>{m.pathType} {m.pathValue}{m.method ? ` · ${m.method}` : ""}</div>))}
          {route.hostnames.length > 0 && <div style={{ color: "var(--color-text-secondary)", marginTop: 4 }}>hostnames: {route.hostnames.join(", ")}</div>}
        </div>
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 5 }}>backends</div>
          {route.backends.map((b, i) => (<div key={i}>{b.name}:{b.port}{b.weight ? ` · weight ${b.weight}` : ""}</div>))}
        </div>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>attached policies</div>
        {(() => {
          const svcPolicies = route.services.flatMap((s) => s.policies);
          const all = [...route.policies, ...svcPolicies];
          if (all.length === 0) {
            return <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>None on this route.</div>;
          }
          return all.map((p, idx) => (
            <div
              key={`${p.kind}/${p.namespace}/${p.name}`}
              style={{
                marginBottom: 12,
                paddingBottom: idx < all.length - 1 ? 8 : 0,
                borderBottom: idx < all.length - 1 ? "0.5px solid var(--color-border-tertiary)" : undefined,
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ fontWeight: 600 }}>{p.kind} {p.namespace}/{p.name}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
                Target: {p.targetKind} {p.targetNamespace}/{p.targetName}{p.targetSectionName ? ` (Section: ${p.targetSectionName})` : ""}
              </div>
              {p.summary && <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>Features: {p.summary}</div>}
              {p.details.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {p.details.map((d, i) => (
                    <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-secondary)" }}>{d.key}: {d.value}</div>
                  ))}
                </div>
              )}
            </div>
          ));
        })()}
        {(() => {
          const cnps = route.services.flatMap((s) => s.cnps);
          if (cnps.length === 0) return null;
          return (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>inferred network policies</div>
              {cnps.map((p) => (
                <div key={`${p.kind}/${p.namespace}/${p.name}`} style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600 }}>{`${p.kind} ${p.namespace}/${p.name}`}</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Target: Pods selected via Service ${p.targetNamespace}/${p.targetName}`}</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Inferred via: ${p.match}`}</div>
                  {p.summary && <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{`Features: ${p.summary}`}</div>}
                  {p.details.map((d, i) => (
                    <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-secondary)" }}>{d.key}: {d.value}</div>
                  ))}
                </div>
              ))}
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>cluster-wide policies are shown in the topology header.</div>
            </div>
          );
        })()}
        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>Gateway policies are shown in the topology header.</div>
      </div>
    </div>
  );
}
