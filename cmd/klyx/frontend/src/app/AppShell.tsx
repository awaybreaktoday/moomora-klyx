import { useFleet } from "../store/fleet";
import { Sidebar } from "../chrome/Sidebar";
import { TopBar } from "../chrome/TopBar";
import { Header } from "../chrome/Header";
import { FleetView } from "../fleet/FleetView";
import { ClusterDetail } from "../cluster/ClusterDetail";
import { CommandPalette } from "../chrome/CommandPalette";
import { ActionToast } from "../chrome/ActionToast";

export function AppShell() {
  const route = useFleet((s) => s.route);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <CommandPalette />
      <TopBar />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Sidebar />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--color-background-primary)" }}>
          <Header />
          <div style={{ flex: 1, overflow: "auto" }}>
            {route.name === "fleet" ? <FleetView /> : <ClusterDetail />}
          </div>
        </div>
      </div>
      <ActionToast />
    </div>
  );
}
