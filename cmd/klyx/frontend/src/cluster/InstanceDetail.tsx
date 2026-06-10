import { useEffect, useRef, useState } from "react";
import { useFleet, ResourceRef, InstanceRef, SecretKeyDTO, ServiceBackingDTO } from "../store/fleet";
import { getInstanceDetail, revealSecretKey, copyText } from "../bridge/crd";
import { openPodDetail } from "../bridge/pods";

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

// SecretDataSection renders the data section for a v1 Secret. Each key row
// shows the key name, byte count, masked/revealed value, reveal toggle, and
// a copy-without-reveal button. Revealed values are local to this component
// and are cleared on unmount.
function SecretDataSection({
  cluster, ns, name, keys,
}: {
  cluster: string; ns: string; name: string; keys: SecretKeyDTO[];
}) {
  // revealedValues: key -> decoded string. Never pushed to the store.
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  // copyStates: key -> "idle" | "copied" | "error"
  const [copyStates, setCopyStates] = useState<Record<string, string>>({});
  // revealErrors: key -> error message
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});

  // Clear revealed values on unmount (navigation away).
  const revealedRef = useRef(revealedValues);
  revealedRef.current = revealedValues;

  const handleReveal = async (key: string) => {
    if (revealedValues[key] !== undefined) {
      // Re-mask: remove from state.
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRevealErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const val = await revealSecretKey(cluster, ns, name, key);
    if (val === null) {
      setRevealErrors((prev) => ({ ...prev, [key]: "Could not fetch value" }));
      return;
    }
    setRevealErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setRevealedValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleCopy = async (key: string) => {
    // Always fetch fresh — do not read from component state to keep the
    // flow explicit and avoid clipboard accidents from stale state.
    const val = await revealSecretKey(cluster, ns, name, key);
    if (val === null) {
      setCopyStates((prev) => ({ ...prev, [key]: "error" }));
      setTimeout(() => setCopyStates((prev) => ({ ...prev, [key]: "idle" })), 1500);
      return;
    }
    await copyText(val);
    setCopyStates((prev) => ({ ...prev, [key]: "copied" }));
    setTimeout(() => setCopyStates((prev) => ({ ...prev, [key]: "idle" })), 1500);
  };

  return (
    <Section title={`Data (${keys.length} keys)`}>
      {keys.map(({ key, bytes }) => {
        const revealed = revealedValues[key];
        const isRevealed = revealed !== undefined;
        const copyState = copyStates[key] ?? "idle";
        const errMsg = revealErrors[key];
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, flex: "0 0 auto", maxWidth: 220, ...ellipsis }} title={key}>{key}</span>
              <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>{bytes} bytes</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => void handleReveal(key)}
                style={{ ...btnSm }}
                title={isRevealed ? "Hide value" : "Reveal value"}
              >
                {isRevealed ? "Hide" : "Reveal"}
              </button>
              <button
                onClick={() => void handleCopy(key)}
                style={{ ...btnSm }}
                title="Copy decoded value to clipboard (no display)"
              >
                {copyState === "copied" ? "Copied" : copyState === "error" ? "Error" : "Copy"}
              </button>
            </div>
            {errMsg && (
              <div style={{ fontSize: 11, color: "var(--color-text-danger)", marginLeft: 4 }}>{errMsg}</div>
            )}
            {isRevealed && (
              <pre style={{
                margin: 0, padding: "6px 8px",
                background: "var(--color-background-secondary)",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: "var(--border-radius-md)",
                fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5,
                whiteSpace: "pre-wrap", wordBreak: "break-all",
                maxHeight: 120, overflow: "auto",
                color: "var(--color-text-primary)",
              }}>
                {revealed}
              </pre>
            )}
            {!isRevealed && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-tertiary)", letterSpacing: 2, paddingLeft: 4 }}>
                {"•".repeat(Math.min(bytes, 16))}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ServiceBackingSection renders endpoint health for a v1 Service: a summary
// line (ready/notReady counts), port list, address list (with pod cross-links
// for Pod-targeted endpoints), and selector chips.
function ServiceBackingSection({
  cluster, backing,
}: {
  cluster: string;
  backing: ServiceBackingDTO;
}) {
  const summaryColor = backing.ready > 0 ? "var(--color-text-success)" : "var(--color-text-danger)";
  const summaryText = backing.ready > 0
    ? `${backing.ready} ready / ${backing.notReady} not ready`
    : `no ready endpoints (${backing.notReady} not ready)`;

  const handlePodLink = (ns: string, name: string) => {
    useFleet.getState().setSection("pods");
    void openPodDetail(cluster, ns, name);
  };

  return (
    <Section title="Backing">
      {/* Summary line */}
      <div style={{ color: summaryColor, fontWeight: 500, fontSize: 12, marginBottom: 4 }}>
        {summaryText}
      </div>

      {/* Ports row */}
      {backing.ports.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          {backing.ports.map((p, i) => (
            <span key={i} style={{ fontSize: 11, background: "var(--color-background-secondary)", padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
              {p.name ? `${p.name} ` : ""}{p.port}/{p.protocol}
            </span>
          ))}
        </div>
      )}

      {/* Address list */}
      {backing.addresses.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4 }}>
          {backing.addresses.map((a, i) => {
            const dot = (
              <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0, background: a.ready ? "var(--color-text-success)" : "var(--color-text-danger)" }} />
            );
            const target = a.targetKind === "Pod" ? (
              <button
                onClick={() => handlePodLink(/* pod is in same ns as service */ "", a.targetName)}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--color-text-info)", fontFamily: "var(--font-mono)", fontSize: 11, textAlign: "left" }}
                title={`${a.targetKind}/${a.targetName}`}
                data-testid={`pod-link-${a.targetName}`}
              >
                {a.targetName}
              </button>
            ) : a.targetName ? (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)" }}>{a.targetName}</span>
            ) : null;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {dot}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-primary)" }}>{a.ip}</span>
                {target}
              </div>
            );
          })}
        </div>
      )}

      {/* Selector chips */}
      {backing.selector && Object.keys(backing.selector).length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {Object.entries(backing.selector).map(([k, v]) => (
            <span key={k} style={{ fontSize: 10, background: "var(--color-background-secondary)", color: "var(--color-text-tertiary)", padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>{k}={v}</span>
          ))}
        </div>
      )}
    </Section>
  );
}

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

          {/* Service backing section — rendered ABOVE yaml, ONLY for v1 Services */}
          {d.serviceBacking != null && (
            <ServiceBackingSection cluster={cluster} backing={d.serviceBacking} />
          )}

          {/* Secret data section — rendered ABOVE yaml, ONLY for Secrets */}
          {d.secretKeys && d.secretKeys.length > 0 && (
            <SecretDataSection cluster={cluster} ns={instance.namespace} name={instance.name} keys={d.secretKeys} />
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

const btnSm: React.CSSProperties = {
  ...btn, padding: "2px 8px", fontSize: 10,
};
