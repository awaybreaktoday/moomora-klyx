import { useEffect } from "react";
import { useFleet, GatewayRef, RouteNodeDTO } from "../store/fleet";
import { getGatewayTopology } from "../bridge/gateway";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const nb: React.CSSProperties = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "8px 9px", minWidth: 0 };
const lab: React.CSSProperties = { fontSize: 9, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: 3 };
const nm: React.CSSProperties = { fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", ...ellipsis };
const chev: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-tertiary)" };

const routeKey = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;
const dot = (ok: boolean) => (ok ? "var(--color-text-success)" : "var(--color-text-danger)");

export function NetworkTopology({ cluster, gateway }: { cluster: string; gateway: GatewayRef }) {
  const net = useFleet((s) => s.network);
  const selectRoute = useFleet((s) => s.selectRoute);

  useEffect(() => {
    void getGatewayTopology(cluster, gateway);
    return () => useFleet.getState().clearNetwork();
  }, [cluster, gateway.namespace, gateway.name]);

  const isCurrent = net.selected && net.selected.namespace === gateway.namespace && net.selected.name === gateway.name;
  const t = isCurrent ? net.topology : null;

  if (net.topologyLoading && !t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading topology…</div>;
  if (!t) return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>Could not load the topology.</div>;

  const selected = t.routes.find((r) => routeKey(r) === net.selectedRoute) ?? null;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{t.gateway.name}</div>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: t.gateway.programmed ? "var(--color-background-success)" : "var(--color-background-warning)", color: t.gateway.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }}>{t.gateway.programmed ? "programmed" : "pending"}</span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t.gateway.className}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => void getGatewayTopology(cluster, gateway)} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>Refresh</button>
      </div>

      {t.error && (
        <div style={{ marginBottom: 12, padding: "8px 10px", fontSize: 12, borderRadius: 4, background: "var(--color-background-danger)", color: "var(--color-text-danger)", border: "0.5px solid var(--color-border-danger)" }}>{t.error}</div>
      )}

      {t.routes.length === 0 && !t.error ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No HTTPRoutes attached to this Gateway.</div>
      ) : (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "14px 12px" }}>
          {t.routes.map((r) => {
            const svc = r.services[0];
            return (
              <div key={routeKey(r)} style={{ display: "grid", gridTemplateColumns: "150px 20px 1fr 20px 130px 20px 130px", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
                <div style={nb}>
                  <div style={lab}>gateway</div><div style={nm}>{t.gateway.namespace}/{t.gateway.name}</div>
                  <div style={{ fontSize: 9, color: "var(--color-text-secondary)", marginTop: 2 }}>{t.gateway.listeners.map((l) => `${l.protocol}:${l.port}`).join(" · ")}</div>
                </div>
                <div style={chev}>›</div>
                <div style={{ ...nb, borderColor: "var(--color-border-info)", cursor: "pointer", boxShadow: net.selectedRoute === routeKey(r) ? "0 0 0 1px var(--color-text-info)" : undefined }} onClick={() => selectRoute(routeKey(r))}>
                  <div style={{ ...lab, color: "var(--color-text-info)" }}>httproute</div>
                  <div style={{ ...nm, color: "var(--color-text-info)" }}>{r.name}</div>
                  <div style={{ fontSize: 9, marginTop: 2, ...ellipsis }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: dot(r.accepted), display: "inline-block", marginRight: 4 }} />{r.accepted ? "accepted" : "rejected"} · {r.matches[0]?.pathValue ?? "/"}</div>
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>service</div>
                  <div style={nm}>{svc ? svc.name : "—"}</div>
                  <div style={{ fontSize: 9, color: svc?.resolved ? "var(--color-text-secondary)" : "var(--color-text-danger)", marginTop: 2 }}>{!svc ? "no backend" : svc.resolved ? `${svc.type} :${svc.port}` : "unresolved"}{r.backends.length > 1 ? ` · +${r.backends.length - 1}` : ""}</div>
                </div>
                <div style={chev}>›</div>
                <div style={nb}>
                  <div style={lab}>pods</div>
                  <div style={nm}>{r.pods.unknown ? "unknown" : `${r.pods.ready} / ${r.pods.total}`}</div>
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
    </div>
  );
}
