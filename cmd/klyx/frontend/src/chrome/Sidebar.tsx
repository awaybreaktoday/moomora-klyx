import {
  IconLayoutGrid, IconLayoutDashboard, IconStack2, IconGitBranch,
  IconRoute, IconChartLine, IconTerminal2, IconSettings, IconBox, IconCircleDot, IconAlertTriangle, IconServer,
} from "@tabler/icons-react";
import { useFleet, ClusterSection, SECTION_LABELS } from "../store/fleet";

const SECTION_ICONS: { section: ClusterSection; Icon: typeof IconLayoutDashboard }[] = [
  { section: "overview", Icon: IconLayoutDashboard },
  { section: "resources", Icon: IconStack2 },
  { section: "gitops", Icon: IconGitBranch },
  { section: "network", Icon: IconRoute },
  { section: "workloads", Icon: IconBox },
  { section: "pods", Icon: IconCircleDot },
  { section: "events", Icon: IconAlertTriangle },
  { section: "nodes", Icon: IconServer },
  { section: "observability", Icon: IconChartLine },
];

export function Sidebar() {
  const route = useFleet((s) => s.route);
  const openFleet = useFleet((s) => s.openFleet);
  const setSection = useFleet((s) => s.setSection);
  const inCluster = route.name === "cluster";

  return (
    <div style={{
      width: 46, background: "var(--color-background-secondary)",
      borderRight: "0.5px solid var(--color-border-tertiary)",
      padding: "10px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 6, marginBottom: 6,
        background: "var(--color-text-primary)", color: "var(--color-background-primary)",
        display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 500, fontSize: 12,
      }}>K</div>

      <RailButton label="Fleet" active={route.name === "fleet"} onClick={openFleet}>
        <IconLayoutGrid size={16} stroke={1.5} />
      </RailButton>

      {SECTION_ICONS.map(({ section, Icon }) => (
        <RailButton
          key={section}
          label={SECTION_LABELS[section]}
          disabled={!inCluster}
          active={inCluster && route.section === section}
          onClick={() => setSection(section)}
        >
          <Icon size={16} stroke={1.5} />
        </RailButton>
      ))}

      <div style={{ flex: 1 }} />
      <RailButton label="Terminal" disabled><IconTerminal2 size={16} stroke={1.5} /></RailButton>
      <RailButton label="Settings" disabled><IconSettings size={16} stroke={1.5} /></RailButton>
    </div>
  );
}

function RailButton({ label, active, disabled, onClick, children }: {
  label: string; active?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 6, padding: 0, cursor: disabled ? "default" : "pointer",
        background: active ? "var(--color-background-primary)" : "transparent",
        border: active ? "0.5px solid var(--color-border-secondary)" : "0.5px solid transparent",
        color: disabled ? "var(--color-text-tertiary)" : active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
