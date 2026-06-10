import { useState } from "react";
import {
  IconLayoutGrid, IconLayoutDashboard, IconStack2, IconGitBranch,
  IconRoute, IconChartLine, IconTerminal2, IconSettings, IconBox, IconCircleDot,
  IconAlertTriangle, IconServer, IconAnchor, IconChevronRight, IconChevronLeft,
} from "@tabler/icons-react";
import { useFleet, ClusterSection, SECTION_LABELS } from "../store/fleet";

const COLLAPSED_WIDTH = 46;
const EXPANDED_WIDTH = 190;

// daily-driver triage order
const SECTION_ICONS: { section: ClusterSection; Icon: typeof IconLayoutDashboard }[] = [
  { section: "overview",      Icon: IconLayoutDashboard },
  { section: "workloads",     Icon: IconBox },
  { section: "pods",          Icon: IconCircleDot },
  { section: "events",        Icon: IconAlertTriangle },
  { section: "nodes",         Icon: IconServer },
  { section: "resources",     Icon: IconStack2 },
  { section: "network",       Icon: IconRoute },
  { section: "gitops",        Icon: IconGitBranch },
  { section: "helm",          Icon: IconAnchor },
  { section: "observability", Icon: IconChartLine },
];

function readPersistedExpanded(): boolean {
  try { return localStorage.getItem("klyx-sidebar-expanded") === "1"; } catch { return false; }
}

export function Sidebar() {
  const route = useFleet((s) => s.route);
  const openFleet = useFleet((s) => s.openFleet);
  const setSection = useFleet((s) => s.setSection);
  const inCluster = route.name === "cluster";

  const [expanded, setExpanded] = useState<boolean>(readPersistedExpanded);

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem("klyx-sidebar-expanded", next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  }

  const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;

  return (
    <div style={{
      width,
      minWidth: width,
      transition: "width 120ms ease, min-width 120ms ease",
      background: "var(--color-background-secondary)",
      borderRight: "0.5px solid var(--color-border-tertiary)",
      padding: "10px 0",
      display: "flex",
      flexDirection: "column",
      alignItems: expanded ? "stretch" : "center",
      gap: 4,
      overflow: "hidden",
    }}>
      {/* Logo mark */}
      <div style={{
        width: 28, height: 28, borderRadius: 6,
        margin: expanded ? "0 0 6px 9px" : "0 auto 6px auto",
        background: "var(--color-text-primary)", color: "var(--color-background-primary)",
        display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 500, fontSize: 12,
        flexShrink: 0,
      }}>K</div>

      {/* Fleet home */}
      <RailButton
        label="Fleet"
        active={route.name === "fleet"}
        onClick={openFleet}
        expanded={expanded}
      >
        <IconLayoutGrid size={16} stroke={1.5} />
      </RailButton>

      {/* Section nav */}
      {SECTION_ICONS.map(({ section, Icon }) => (
        <RailButton
          key={section}
          label={SECTION_LABELS[section]}
          disabled={!inCluster}
          active={inCluster && route.section === section}
          onClick={() => setSection(section)}
          expanded={expanded}
        >
          <Icon size={16} stroke={1.5} />
        </RailButton>
      ))}

      <div style={{ flex: 1 }} />

      {/* Bottom placeholders */}
      <RailButton label="Terminal" disabled expanded={expanded}>
        <IconTerminal2 size={16} stroke={1.5} />
      </RailButton>
      <RailButton label="Settings" disabled expanded={expanded}>
        <IconSettings size={16} stroke={1.5} />
      </RailButton>

      {/* Collapse/expand toggle */}
      <button
        aria-label={expanded ? "collapse sidebar" : "expand sidebar"}
        title={expanded ? "collapse sidebar" : "expand sidebar"}
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center",
          justifyContent: expanded ? "flex-start" : "center",
          gap: 8,
          width: expanded ? "calc(100% - 18px)" : 32,
          height: 32,
          margin: expanded ? "0 9px" : "0 auto",
          borderRadius: 6, padding: expanded ? "0 8px" : 0,
          cursor: "pointer",
          background: "transparent",
          border: "0.5px solid transparent",
          color: "var(--color-text-tertiary)",
        }}
      >
        {expanded
          ? <IconChevronLeft size={14} stroke={1.5} />
          : <IconChevronRight size={14} stroke={1.5} />}
        {expanded && <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>collapse sidebar</span>}
      </button>
    </div>
  );
}

function RailButton({ label, active, disabled, onClick, children, expanded }: {
  label: string; active?: boolean; disabled?: boolean; onClick?: () => void;
  children: React.ReactNode; expanded: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={expanded ? undefined : label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        justifyContent: expanded ? "flex-start" : "center",
        width: expanded ? "calc(100% - 18px)" : 32,
        height: 32,
        margin: expanded ? "0 9px" : "0 auto",
        borderRadius: 6,
        padding: expanded ? "0 8px" : 0,
        cursor: disabled ? "default" : "pointer",
        background: active ? "var(--color-background-primary)" : "transparent",
        border: active ? "0.5px solid var(--color-border-secondary)" : "0.5px solid transparent",
        color: disabled ? "var(--color-text-tertiary)" : active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{children}</span>
      {expanded && (
        <span style={{
          fontSize: 12,
          fontWeight: active ? 500 : 400,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {label}
        </span>
      )}
    </button>
  );
}
