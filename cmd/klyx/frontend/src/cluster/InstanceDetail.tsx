import { useEffect, useState } from "react";
import { useFleet, ResourceRef, InstanceRef } from "../store/fleet";
import { getInstanceDetail, copyText } from "../bridge/crd";

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

const condColor = (status: string) =>
  status === "True" ? "var(--color-text-success)" : status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)";

export function InstanceDetail({ cluster, resource, instance }: { cluster: string; resource: ResourceRef; instance: InstanceRef }) {
  const id = useFleet((s) => s.instanceDetail);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getInstanceDetail(cluster, resource, instance);
    return () => useFleet.getState().clearInstanceDetail();
  }, [cluster, resource.group, resource.version, resource.plural, instance.namespace, instance.name]);

  const isCurrent = id.ref && id.ref.namespace === instance.namespace && id.ref.name === instance.name;
  const d = isCurrent ? id.detail : null;

  const onCopy = () => {
    if (!d) return;
    void copyText(d.yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{resource.kind}</div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {instance.namespace ? `${instance.namespace}/` : ""}{instance.name}
        </span>
        {d && d.created && <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{age(d.created)}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => void getInstanceDetail(cluster, resource, instance)} style={btn}>Refresh</button>
      </div>

      {id.loading && !d ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading detail…</div>
      ) : !d ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Could not load this instance.</div>
      ) : (
        <>
          {Object.keys(d.labels).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {Object.entries(d.labels).map(([k, v]) => (
                <span key={k} style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 10, padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>{k}={v}</span>
              ))}
            </div>
          )}

          {d.conditions.length > 0 && (
            <Section title="Conditions">
              {d.conditions.map((c) => (
                <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c.status), display: "inline-block" }} />
                  <span style={{ fontWeight: 500, width: 90 }}>{c.type}</span>
                  <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
                </div>
              ))}
            </Section>
          )}

          <Section title={`Events (${d.events.length})`}>
            {d.events.length === 0 ? (
              <span style={{ color: "var(--color-text-tertiary)" }}>No events for this object.</span>
            ) : (
              d.events.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", color: e.type === "Warning" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
                  <span style={{ width: 56, fontSize: 10, textTransform: "uppercase" }}>{e.type}</span>
                  <span style={{ fontWeight: 500, width: 120, ...ellipsis }}>{e.reason}</span>
                  <span style={{ ...ellipsis }} title={e.message}>{e.message}</span>
                  {e.count > 1 && <span style={{ color: "var(--color-text-tertiary)" }}>×{e.count}</span>}
                  <span style={{ color: "var(--color-text-tertiary)" }}>{age(e.lastSeen)}</span>
                </div>
              ))
            )}
          </Section>

          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>YAML</div>
              <div style={{ flex: 1 }} />
              <button onClick={onCopy} style={btn}>{copied ? "Copied" : "Copy"}</button>
            </div>
            <pre style={{ margin: 0, padding: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: "60vh", color: "var(--color-text-primary)" }}>{d.yaml}</pre>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>{children}</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
  border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)",
};
