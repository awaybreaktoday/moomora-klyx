import { useEffect } from "react";
import { useFleet, FluxResourceDTO, ResourceDetailDTO } from "../store/fleet";
import { openGitOps, closeGitOps, getResourceDetail } from "../bridge/gitops";

const readyColor: Record<string, string> = {
  Ready: "var(--color-text-success)",
  Reconciling: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unknown: "var(--color-text-tertiary)",
};
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function shortRev(rev: string): string {
  if (!rev) return "";
  const s = rev.replace(/^refs\/heads\//, "");
  const at = s.indexOf("@");
  if (at < 0) return s;
  const branch = s.slice(0, at);
  const sha = s.slice(at + 1).replace(/^sha1:/, "").replace(/^sha256:/, "");
  return `${branch}@${sha.slice(0, 7)}`;
}
function ago(sec: number): string {
  if (sec <= 0) return "";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
const keyOf = (r: { kind: string; namespace: string; name: string }) => `${r.kind}/${r.namespace}/${r.name}`;

export function GitOps({ cluster }: { cluster: string }) {
  const tier = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.gitopsTier ?? "Unknown");
  const gitops = useFleet((s) => s.gitops);
  const expand = useFleet((s) => s.expand);
  const collapse = useFleet((s) => s.collapse);
  const absent = tier === "Absent";

  useEffect(() => {
    if (absent) return;
    let off = () => {};
    openGitOps(cluster).then((u) => (off = u)).catch((e) => console.error("openGitOps", e));
    return () => {
      off();
      void closeGitOps(cluster);
    };
  }, [cluster, absent]);

  useEffect(() => {
    if (!gitops.expandedKey) return;
    const r = gitops.resources.find((x) => keyOf(x) === gitops.expandedKey);
    if (r) void getResourceDetail(cluster, r.kind, r.namespace, r.name);
  }, [cluster, gitops.expandedKey, gitops.resources]);

  if (absent) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>No Flux or Argo installed on this cluster.</div>;
  }

  const rows = gitops.cluster === cluster ? gitops.resources : [];
  const ks = rows.filter((r) => r.kind === "Kustomization").length;
  const hr = rows.filter((r) => r.kind === "HelmRelease").length;
  const ready = rows.filter((r) => r.ready === "Ready").length;
  const notReady = rows.length - ready;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
        <span>kustomizations <b style={{ color: "var(--color-text-primary)" }}>{ks}</b></span>
        <span>helmreleases <b style={{ color: "var(--color-text-primary)" }}>{hr}</b></span>
        <span>ready <b style={{ color: "var(--color-text-success)" }}>{ready}</b></span>
        <span>not ready <b style={{ color: notReady ? "var(--color-text-warning)" : "var(--color-text-primary)" }}>{notReady}</b></span>
      </div>

      {gitops.loading && rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Loading reconciliation state…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No Flux resources found.</div>
      ) : (
        <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
          {rows.map((r) => {
            const k = keyOf(r);
            const open = gitops.expandedKey === k;
            return (
              <div key={k}>
                <RowSummary r={r} open={open} onClick={() => (open ? collapse() : expand(k))} />
                {open && <DetailPanel resource={r} detail={gitops.detail && keyOf(gitops.detail) === k ? gitops.detail : null} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RowSummary({ r, open, onClick }: { r: FluxResourceDTO; open: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "grid", gridTemplateColumns: "16px minmax(0,1fr) 130px 130px 72px 84px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12, cursor: "pointer", background: open ? "var(--color-background-secondary)" : "transparent" }}>
      <span style={{ color: "var(--color-text-tertiary)" }}>{open ? "▾" : "▸"}</span>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{r.namespace}/{r.name}</span>{" "}
        <span style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}>{r.kind === "Kustomization" ? "ks" : "hr"}</span>
        {r.message && r.ready === "Failed" && (
          <div style={{ color: "var(--color-text-danger)", fontSize: 11, marginTop: 2, ...ellipsis }}>{r.message}</div>
        )}
      </div>
      <div style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={r.sourceName}>{r.sourceName}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", ...ellipsis }} title={r.revision}>{shortRev(r.revision)}</div>
      <div style={{ color: "var(--color-text-tertiary)", fontSize: 11, ...ellipsis }}>{ago(r.lastAppliedAgeSeconds)}</div>
      <div style={{ ...ellipsis, color: r.suspended ? "var(--color-text-warning)" : (readyColor[r.ready] ?? "var(--color-text-tertiary)") }}>
        {r.suspended ? "suspended" : r.ready.toLowerCase()}
      </div>
    </div>
  );
}

function DetailPanel({ resource, detail }: { resource: FluxResourceDTO; detail: ResourceDetailDTO | null }) {
  if (!detail) {
    return <div style={{ padding: "6px 12px 12px 38px", fontSize: 12, color: "var(--color-text-secondary)" }}>Loading detail…</div>;
  }
  const condColor = (c: { status: string }) => (c.status === "True" ? "var(--color-text-success)" : c.status === "False" ? "var(--color-text-danger)" : "var(--color-text-info)");
  return (
    <div style={{ padding: "6px 12px 14px 38px", background: "var(--color-background-secondary)", fontSize: 12 }}>
      {detail.applyFailed && (
        <div style={{ color: "var(--color-text-danger)", marginBottom: 8 }}>apply failed at <span style={{ fontFamily: "var(--font-mono)" }}>{shortRev(detail.attemptedRevision)}</span></div>
      )}
      <Section title="Conditions">
        {detail.conditions.length === 0 ? <Muted>none reported</Muted> : detail.conditions.map((c) => (
          <div key={c.type} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: condColor(c), display: "inline-block" }} />
            <span style={{ fontWeight: 500, width: 70 }}>{c.type}</span>
            <span style={{ color: "var(--color-text-secondary)", ...ellipsis }} title={c.message}>{c.message || c.reason}</span>
          </div>
        ))}
      </Section>
      {resource.kind === "Kustomization" ? (
        <Section title={`Inventory (${detail.inventory.length})`}>
          {detail.inventory.length === 0 ? <Muted>no managed objects</Muted> : detail.inventory.map((e) => (
            <div key={`${e.kind}/${e.namespace}/${e.name}`} style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", ...ellipsis }}>
              {e.kind} · {e.namespace ? `${e.namespace}/` : ""}{e.name}
            </div>
          ))}
        </Section>
      ) : (
        <Section title="Inventory"><Muted>no inventory in the HelmRelease CR</Muted></Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{children}</div>
    </div>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--color-text-tertiary)" }}>{children}</span>;
}
