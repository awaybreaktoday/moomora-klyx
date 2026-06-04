import React, { useEffect } from "react";
import { useFleet, FluxResourceDTO } from "../store/fleet";
import { openGitOps, closeGitOps } from "../bridge/gitops";

const readyColor: Record<string, string> = {
  Ready: "var(--color-text-success)",
  Reconciling: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unknown: "var(--color-text-tertiary)",
};

export function GitOps({ cluster }: { cluster: string }) {
  const tier = useFleet((s) => s.clusters.find((c) => c.name === cluster)?.gitopsTier ?? "Unknown");
  const gitops = useFleet((s) => s.gitops);
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
          {rows.map((r) => <Row key={`${r.kind}/${r.namespace}/${r.name}`} r={r} />)}
        </div>
      )}
    </div>
  );
}

function shortRev(rev: string): string {
  if (!rev) return "";
  const s = rev.replace(/^refs\/heads\//, "");
  const at = s.indexOf("@");
  if (at < 0) return s; // chart version etc., already short
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

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function Row({ r }: { r: FluxResourceDTO }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 130px 130px 72px 84px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12 }}>
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
