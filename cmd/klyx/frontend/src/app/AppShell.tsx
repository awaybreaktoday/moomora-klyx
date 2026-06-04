import { useFleet } from "../store/fleet";
import { Sidebar } from "../chrome/Sidebar";
import { Header } from "../chrome/Header";
import { FleetView } from "../fleet/FleetView";
import { ClusterDetail } from "../cluster/ClusterDetail";

export function AppShell() {
  const route = useFleet((s) => s.route);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--color-background-primary)" }}>
        <Header />
        <div style={{ flex: 1, overflow: "auto" }}>
          {route.name === "fleet" ? <FleetView /> : <ClusterDetail />}
        </div>
      </div>
    </div>
  );
}
