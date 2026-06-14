import { useEffect, useRef, useState } from "react";
import { useFleet, ResourceRef, InstanceRef, SecretKeyDTO, ServiceBackingDTO, HPAScalingDTO, RelatedRefDTO, EventDTO } from "../store/fleet";
import { getInstanceDetail, revealSecretKey, copyText } from "../bridge/crd";
import { openPodDetail } from "../bridge/pods";
import { ForwardPopover } from "./ForwardPopover";

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
type DetailTab = "summary" | "related" | "events" | "yaml";

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

// Conditions where True means trouble and False is the healthy state - the
// inverse of the usual Ready-style polarity. HPA's ScalingLimited=False means
// "the desired count is within range" (good); node pressure conditions are the
// same family. Without this, a healthy HPA renders a red dot.
const NEGATIVE_POLARITY = new Set([
  "ScalingLimited",
  "MemoryPressure",
  "DiskPressure",
  "PIDPressure",
  "NetworkUnavailable",
]);

const condColor = (status: string, type?: string) => {
  const negative = type !== undefined && NEGATIVE_POLARITY.has(type);
  const healthy = negative ? status === "False" : status === "True";
  const unhealthy = negative ? status === "True" : status === "False";
  return healthy ? "var(--color-text-success)" : unhealthy ? "var(--color-text-danger)" : "var(--color-text-info)";
};

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

// ageFromUnix formats a Unix timestamp as a human-readable age string.
// Returns "never" when unix is 0.
function ageFromUnix(unix: number): string {
  if (unix === 0) return "never";
  const ms = Date.now() - unix * 1000;
  if (Number.isNaN(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// parsePercent parses an integer percentage string like "70%" → 70.
// Returns null if the string doesn't end in "%".
function parsePercent(s: string): number | null {
  if (!s.endsWith("%")) return null;
  const n = parseInt(s.slice(0, -1), 10);
  return Number.isNaN(n) ? null : n;
}

// HPAScalingSection renders the scaling summary for an autoscaling HPA:
// replica line, scale-target line (with workloads lens link for
// Deployment/StatefulSet), per-metric table, and last-scale age.
function HPAScalingSection({ cluster, scaling }: { cluster: string; scaling: HPAScalingDTO }) {
  const atMax = scaling.currentReplicas >= scaling.maxReplicas && scaling.desiredReplicas >= scaling.maxReplicas;
  const replicaMismatch = scaling.desiredReplicas !== scaling.currentReplicas;

  const replicaColor = atMax
    ? "var(--color-text-warning)"
    : replicaMismatch
    ? "var(--color-text-info)"
    : "var(--color-text-primary)";

  // Cross-link: for Deployment and StatefulSet, switch to the workloads lens
  // and expand the matching row using the live store state. The workload key
  // is "<kind>/<namespace>/<name>" — we don't know the namespace from the HPA
  // alone so we toggle by name lookup; `toggleWorkloadExpand` handles the key.
  // Since we don't have the HPA's namespace here (the section is standalone),
  // we navigate to workloads and let the user pick; the link is still more
  // useful than plain text.
  const isWorkloadTarget = scaling.targetKind === "Deployment" || scaling.targetKind === "StatefulSet";

  const handleTargetLink = () => {
    useFleet.getState().setSection("workloads");
  };

  const targetEl = isWorkloadTarget ? (
    <button
      onClick={handleTargetLink}
      data-testid="hpa-target-link"
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        color: "var(--color-text-info)", fontFamily: "var(--font-mono)", fontSize: 11,
      }}
    >
      {scaling.targetKind}/{scaling.targetName}
    </button>
  ) : (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)" }}>
      {scaling.targetKind}/{scaling.targetName}
    </span>
  );

  return (
    <Section title="Scaling">
      {/* Replica line: current → desired (min N / max N) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span style={{ color: replicaColor, fontWeight: 500, fontSize: 12 }}>
          {scaling.currentReplicas} → {scaling.desiredReplicas}
        </span>
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>
          (min {scaling.minReplicas} / max {scaling.maxReplicas})
        </span>
        {atMax && (
          <span style={{
            fontSize: 10, background: "var(--color-text-warning)", color: "var(--color-background-primary)",
            padding: "1px 5px", borderRadius: 3, fontWeight: 600,
          }}>
            at max
          </span>
        )}
      </div>

      {/* Scale target line */}
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>
        scales {targetEl}
      </div>

      {/* Metrics table */}
      {scaling.metrics.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {scaling.metrics.map((m, i) => {
            // Colour current value warning when both current and target are "%"
            // and current exceeds target (the classic saturation signal).
            // We only parse percentages — other quantity formats (e.g. "100m") are
            // left neutral because their ordering semantics differ by metric type.
            const targetPct = parsePercent(m.target);
            const currentPct = parsePercent(m.current);
            const currentOverLimit = targetPct !== null && currentPct !== null && currentPct > targetPct;
            const currentColor = currentOverLimit
              ? "var(--color-text-warning)"
              : "var(--color-text-primary)";
            const currentDisplay = m.current === ""
              ? <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
              : <span style={{ color: currentColor }}>{m.current}</span>;

            return (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11, padding: "2px 0" }}>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-primary)", minWidth: 60 }}>{m.name}</span>
                <span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{m.type}</span>
                <span style={{ color: "var(--color-text-secondary)" }}>{currentDisplay} / {m.target}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Last scale */}
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
        last scaled: {ageFromUnix(scaling.lastScaleUnix)}
      </div>
    </Section>
  );
}

// ServiceBackingSection renders endpoint health for a v1 Service: a summary
// line (ready/notReady counts), port list, address list (with pod cross-links
// for Pod-targeted endpoints), and selector chips.
function ServiceBackingSection({
  cluster, ns, serviceName, backing,
}: {
  cluster: string;
  ns: string; // the service's namespace - endpoint pods always live in it
  serviceName: string;
  backing: ServiceBackingDTO;
}) {
  const [forwardPort, setForwardPort] = useState<number | null>(null);
  const summaryColor = backing.ready > 0 ? "var(--color-text-success)" : "var(--color-text-danger)";
  const summaryText = backing.ready > 0
    ? `${backing.ready} ready / ${backing.notReady} not ready`
    : `no ready endpoints (${backing.notReady} not ready)`;

  const handlePodLink = (name: string) => {
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
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4, alignItems: "center" }}>
          {backing.ports.map((p, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {forwardPort === p.port ? (
                <ForwardPopover
                  cluster={cluster}
                  namespace={ns}
                  kind="Service"
                  name={serviceName}
                  prefillTargetPort={p.port}
                  onClose={() => setForwardPort(null)}
                />
              ) : (
                <button
                  onClick={() => setForwardPort(p.port)}
                  data-testid={`svc-forward-${p.port}`}
                  title={`forward ${p.port}`}
                  style={{ fontSize: 11, background: "var(--color-background-secondary)", padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-tertiary)", cursor: "pointer" }}
                >
                  {p.name ? `${p.name} ` : ""}{p.port}/{p.protocol} ⇄
                </button>
              )}
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
                onClick={() => handlePodLink(a.targetName)}
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
  const closeInstance = useFleet((s) => s.closeInstance);
  const closeResource = useFleet((s) => s.closeResource);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<DetailTab>("summary");

  useEffect(() => {
    setTab("summary");
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
    <div style={{ padding: "14px 16px", height: "100%", minHeight: 0, overflow: "hidden", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexShrink: 0 }}>
        <button aria-label="back to resources" onClick={closeResource} style={{ ...linkBtn, color: "var(--color-text-info)" }}>resources</button>
        <span style={{ color: "var(--color-text-tertiary)" }}>/</span>
        <button aria-label="back to resource list" onClick={closeInstance} style={{ ...linkBtn, color: "var(--color-text-info)" }}>{resource.kind}</button>
        <span style={{ color: "var(--color-text-tertiary)" }}>/</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {instance.namespace ? `${instance.namespace}/` : ""}{instance.name}
        </span>
        {d && d.created && <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{age(d.created)}</span>}
        <div style={{ flex: 1 }} />
        <button onClick={() => void getInstanceDetail(cluster, resource, instance)} style={btn}>Refresh</button>
      </div>

      {id.loading && !d ? (
        <div style={stateBox}>Loading {resource.kind} detail…</div>
      ) : !d ? (
        <div style={stateBox}>Could not load {instance.namespace ? `${instance.namespace}/` : ""}{instance.name}.</div>
      ) : (
        <div style={{ minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexShrink: 0 }}>
            <button onClick={() => setTab("summary")} style={tabBtn(tab === "summary")}>summary</button>
            <button onClick={() => setTab("related")} style={tabBtn(tab === "related")}>related {d.related?.length ?? 0}</button>
            <button onClick={() => setTab("events")} style={tabBtn(tab === "events")}>events {d.events.length}</button>
            <button onClick={() => setTab("yaml")} style={tabBtn(tab === "yaml")}>yaml</button>
          </div>

          <div data-testid="instance-detail-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
            {tab === "summary" ? (
              <>
                {Object.keys(d.labels).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {Object.entries(d.labels).map(([k, v]) => (
                      <span key={k} style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 10, padding: "1px 6px", borderRadius: 3, fontFamily: "var(--font-mono)" }}>{k}={v}</span>
                    ))}
                  </div>
                )}

                {d.hpaScaling != null && (
                  <HPAScalingSection cluster={cluster} scaling={d.hpaScaling} />
                )}

                {d.serviceBacking != null && (
                  <ServiceBackingSection cluster={cluster} ns={instance.namespace} serviceName={instance.name} backing={d.serviceBacking} />
                )}

                {d.secretKeys && d.secretKeys.length > 0 && (
                  <SecretDataSection cluster={cluster} ns={instance.namespace} name={instance.name} keys={d.secretKeys} />
                )}

                {d.conditions.length > 0 && (
                  <Section title="Conditions">
                    {d.conditions.map((c) => (
                      <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c.status, c.type), display: "inline-block" }} />
                        <span style={{ fontWeight: 500, flexShrink: 0, whiteSpace: "nowrap" }}>{c.type}</span>
                        <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
                      </div>
                    ))}
                  </Section>
                )}
              </>
            ) : tab === "related" ? (
              <RelatedSection cluster={cluster} related={d.related ?? []} />
            ) : tab === "events" ? (
              <EventsPanel events={d.events} />
            ) : (
              <YamlPanel yaml={d.yaml} copied={copied} onCopy={onCopy} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RelatedSection({ cluster, related }: { cluster: string; related: RelatedRefDTO[] }) {
  const openRelated = (ref: RelatedRefDTO) => {
    if (ref.kind === "Pod") {
      useFleet.getState().setSection("pods");
      void openPodDetail(cluster, ref.namespace, ref.name);
      return;
    }
    useFleet.getState().openResource({
      group: ref.group,
      version: ref.version,
      plural: ref.plural,
      kind: ref.kind,
      scope: ref.scope,
    });
    useFleet.getState().openInstance(ref.namespace, ref.name);
  };

  if (related.length === 0) {
    return <div style={stateBox}>No direct related objects found.</div>;
  }

  const groups = related.reduce<Record<string, RelatedRefDTO[]>>((acc, ref) => {
    const key = ref.relation || "related";
    acc[key] = [...(acc[key] ?? []), ref];
    return acc;
  }, {});

  return (
    <>
      {Object.entries(groups).map(([relation, refs]) => (
        <Section key={relation} title={`${relation} (${refs.length})`}>
          {refs.map((ref) => (
            <button
              key={`${ref.relation}/${ref.group}/${ref.plural}/${ref.namespace}/${ref.name}`}
              onClick={() => openRelated(ref)}
              style={{
                display: "grid",
                gridTemplateColumns: "120px minmax(0, 1fr)",
                gap: 10,
                alignItems: "center",
                textAlign: "left",
                padding: "5px 8px",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: 4,
                background: "var(--color-background-primary)",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              <span style={{ color: "var(--color-text-tertiary)" }}>{ref.kind}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-primary)", ...ellipsis }}>
                {ref.namespace ? `${ref.namespace}/` : ""}{ref.name}
              </span>
            </button>
          ))}
        </Section>
      ))}
    </>
  );
}

function EventsPanel({ events }: { events: EventDTO[] }) {
  return (
    <Section title={`Events (${events.length})`}>
      {events.length === 0 ? (
        <span style={{ color: "var(--color-text-tertiary)" }}>No events for this object.</span>
      ) : (
        events.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", color: e.type === "Warning" ? "var(--color-text-danger)" : "var(--color-text-secondary)" }}>
            <span style={{ width: 56, fontSize: 10, textTransform: "uppercase" }}>{e.type}</span>
            <span style={{ fontWeight: 500, width: 120, ...ellipsis }}>{e.reason}</span>
            <span style={{ ...ellipsis }} title={e.message}>{e.message}</span>
            {e.count > 1 && <span style={{ color: "var(--color-text-tertiary)" }}>x{e.count}</span>}
            <span style={{ color: "var(--color-text-tertiary)" }}>{age(e.lastSeen)}</span>
          </div>
        ))
      )}
    </Section>
  );
}

function YamlPanel({ yaml, copied, onCopy }: { yaml: string; copied: boolean; onCopy: () => void }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)" }}>YAML</div>
        <div style={{ flex: 1 }} />
        <button onClick={onCopy} style={btn}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre style={{ margin: 0, padding: 12, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: "calc(100vh - 210px)", color: "var(--color-text-primary)" }}>{yaml}</pre>
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

const stateBox: React.CSSProperties = {
  color: "var(--color-text-secondary)",
  fontSize: 13,
  padding: 18,
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: "var(--border-radius-md)",
  background: "var(--color-background-primary)",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  cursor: "pointer",
  fontSize: 12,
};

function tabBtn(active: boolean): React.CSSProperties {
  return {
    ...btn,
    color: active ? "var(--color-text-info)" : "var(--color-text-secondary)",
    background: active ? "var(--color-background-info)" : "var(--color-background-primary)",
    border: active ? "0.5px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
  };
}
