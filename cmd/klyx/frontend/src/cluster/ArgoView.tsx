import { useEffect, useState } from "react";
import { useFleet } from "../store/fleet";
import type { ArgoAppDTO } from "../store/fleet";
import { listArgoApps, refreshArgoApp, syncArgoApp } from "../bridge/argo";
import { ConfirmDialog } from "../chrome/ConfirmDialog";

// ArgoView is the Argo CD lens, speaking Argo's vocabulary (synced/degraded,
// never translated into Flux terms). Apps arrive broken-first from the
// backend. On-demand list + refresh; the two imperative verbs (refresh, sync)
// mirror the Flux reconcile pattern: ConfirmDialog + Protected gating, never
// authoring desired state, never pruning.

const keyOf = (a: ArgoAppDTO) => `${a.namespace}/${a.name}`;

const syncColor: Record<string, string> = {
  Synced: "var(--color-text-success)",
  OutOfSync: "var(--color-text-warning)",
};
const healthColor: Record<string, string> = {
  Healthy: "var(--color-text-success)",
  Progressing: "var(--color-text-info)",
  Degraded: "var(--color-text-danger)",
  Missing: "var(--color-text-danger)",
  Suspended: "var(--color-text-warning)",
};

function ago(unix: number): string {
  if (unix === 0) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

const short = (rev: string) => (rev.length > 8 ? rev.slice(0, 8) : rev);

type Pending = { verb: "refresh" | "sync"; app: ArgoAppDTO };

const gridCols = "12px minmax(0,1.2fr) 90px 110px minmax(0,1fr) 90px 90px";

export function ArgoView({ cluster }: { cluster: string }) {
  const argo = useFleet((s) => s.argo);
  const isProtected = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.protected ?? false);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    void listArgoApps(cluster);
    return () => useFleet.getState().clearArgo();
  }, [cluster]);

  const broken = argo.apps.filter((a) => a.broken).length;

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {argo.apps.length} application{argo.apps.length === 1 ? "" : "s"}
          {broken > 0 && <span style={{ color: "var(--color-text-danger)" }}> · {broken} need attention</span>}
        </span>
        <button onClick={() => void listArgoApps(cluster)} style={btn}>refresh</button>
      </div>

      {argo.loading && argo.apps.length === 0 ? (
        <div style={emptyStyle}>Loading applications…</div>
      ) : !argo.available ? (
        <div style={emptyStyle}>{argo.message || "Argo CD is not available on this cluster."}</div>
      ) : argo.apps.length === 0 ? (
        <div style={emptyStyle}>No Argo CD applications on this cluster.</div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, padding: "0 8px 6px", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-secondary)" }}>
            <span /><span>application</span><span>sync</span><span>health</span><span>destination</span><span>revision</span><span>reconciled</span>
          </div>
          {argo.apps.map((a) => {
            const expanded = argo.expanded.includes(keyOf(a));
            return (
              <div key={keyOf(a)}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => useFleet.getState().toggleArgoExpand(keyOf(a))}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); useFleet.getState().toggleArgoExpand(keyOf(a)); } }}
                  style={{ display: "grid", gridTemplateColumns: gridCols, gap: 10, alignItems: "center", padding: "7px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", outline: "none" }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.broken ? "var(--color-text-danger)" : "var(--color-text-success)" }} />
                  <span style={ellipsis} title={keyOf(a)}>
                    <span style={{ fontWeight: 500 }}>{a.name}</span>
                    {a.project && a.project !== "default" && <span style={{ color: "var(--color-text-tertiary)", marginLeft: 6, fontSize: 10 }}>{a.project}</span>}
                    {a.autoSync && <span style={{ color: "var(--color-text-tertiary)", marginLeft: 6, fontSize: 9 }} title="automated sync policy">auto</span>}
                  </span>
                  <span style={{ color: syncColor[a.syncStatus] ?? "var(--color-text-tertiary)" }}>{a.syncStatus}</span>
                  <span style={{ color: healthColor[a.healthStatus] ?? "var(--color-text-tertiary)" }}>{a.healthStatus}</span>
                  <span style={{ ...ellipsis, color: "var(--color-text-tertiary)" }} title={a.destNamespace}>{a.destNamespace || "—"}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }} title={a.revision}>{a.revision ? short(a.revision) : "—"}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{ago(a.reconciledUnix)}</span>
                </div>
                {expanded && (
                  <div style={{ padding: "8px 8px 10px 32px", background: "var(--color-background-secondary)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                    <div style={{ marginBottom: 4 }}>
                      <span style={{ color: "var(--color-text-tertiary)" }}>source </span>
                      {a.repoURL}{a.chart ? ` · chart ${a.chart}` : a.path ? ` · ${a.path}` : ""} @ {a.targetRevision || "HEAD"}
                      {a.extraSources > 0 && <span style={{ color: "var(--color-text-tertiary)" }}> · +{a.extraSources} more source{a.extraSources === 1 ? "" : "s"}</span>}
                    </div>
                    {a.opPhase && (
                      <div style={{ marginBottom: 4, color: a.opPhase === "Succeeded" ? "var(--color-text-tertiary)" : "var(--color-text-warning)" }}>
                        last operation: {a.opPhase}{a.opMessage ? ` · ${a.opMessage}` : ""}
                      </div>
                    )}
                    {a.conditions.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        {a.conditions.map((c, i) => (
                          <div key={i} style={{ color: "var(--color-text-danger)" }}>⚠ {c.type}: {c.message}</div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <button onClick={(e) => { e.stopPropagation(); setPending({ verb: "refresh", app: a }); }} style={btn}>refresh app</button>
                      <button onClick={(e) => { e.stopPropagation(); setPending({ verb: "sync", app: a }); }} style={btn}>sync</button>
                      <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", alignSelf: "center" }}>sync never prunes - prune stays in Argo's own tooling</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.verb === "refresh" ? "refresh application" : "sync application"}
          cluster={cluster}
          detail={pending.verb === "refresh"
            ? `${keyOf(pending.app)} — re-compare against ${pending.app.targetRevision || "HEAD"}`
            : `${keyOf(pending.app)} — sync to ${pending.app.targetRevision || "HEAD"} (no prune)`}
          protected={isProtected}
          confirmLabel={pending.verb === "refresh" ? "Refresh" : "Sync"}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { verb, app } = pending;
            setPending(null);
            if (verb === "refresh") void refreshArgoApp(cluster, app.namespace, app.name);
            else void syncArgoApp(cluster, app.namespace, app.name, app.targetRevision);
          }}
        />
      )}
    </div>
  );
}

const btn: React.CSSProperties = { fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-secondary)" };
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const emptyStyle: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: 13 };
