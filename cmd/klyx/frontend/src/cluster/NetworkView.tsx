import { useEffect } from "react";
import { useFleet } from "../store/fleet";
import { listGateways } from "../bridge/gateway";
import { NetworkTopology } from "./NetworkTopology";

const empty: React.CSSProperties = { padding: 24, color: "var(--color-text-secondary)", fontSize: 13 };

export function NetworkView({ cluster }: { cluster: string }) {
  const route = useFleet((s) => s.route);
  const net = useFleet((s) => s.network);
  const openGateway = useFleet((s) => s.openGateway);

  const gateway = route.name === "cluster" ? route.gateway : undefined;

  useEffect(() => {
    if (!gateway) listGateways(cluster).catch((e) => console.error("listGateways", e));
  }, [cluster, gateway]);

  if (gateway) return <NetworkTopology cluster={cluster} gateway={gateway} />;

  if (net.listLoading && net.gateways.length === 0) return <div style={empty}>Loading Gateways…</div>;
  if (!net.served) return <div style={empty}>Gateway API is not installed on this cluster.</div>;
  if (net.gateways.length === 0) return <div style={empty}>No Gateways found.</div>;

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
        <b style={{ color: "var(--color-text-primary)" }}>{net.gateways.length}</b> gateways
      </div>
      <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", overflow: "hidden" }}>
        {net.gateways.map((g) => (
          <div key={`${g.namespace}/${g.name}`} onClick={() => openGateway(g.namespace, g.name)}
            style={{ display: "grid", gridTemplateColumns: "16px 1fr 130px 90px", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 12, cursor: "pointer" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }} />
            <span style={{ fontFamily: "var(--font-mono)" }}>
              <span style={{ color: "var(--color-text-tertiary)" }}>{g.namespace}/</span>
              <span>{g.name}</span>
            </span>
            <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>{g.className}</span>
            <span style={{ fontSize: 11, color: g.programmed ? "var(--color-text-success)" : "var(--color-text-warning)" }}>{g.programmed ? "programmed" : "pending"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
