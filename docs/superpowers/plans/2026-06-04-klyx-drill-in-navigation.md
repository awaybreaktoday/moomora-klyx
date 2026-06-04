# Klyx Drill-in Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the app chrome (sidebar/header/breadcrumb), a styled theme toggle, and clickable cards that drill into a per-cluster detail shell (a real Overview + honest capability-aware placeholders) - fleet-root navigation with cluster-scoped sections.

**Architecture:** Route state lives in the existing Zustand store (`fleet` ↔ `cluster`/section); no router dep. New `chrome/` and `cluster/` component groups compose into an `AppShell` that renders `FleetView` or `ClusterDetail` by route. Frontend-only - no Go/`appbridge` changes; the Overview reuses the existing `ClusterDTO` and stays live via the 1s push.

**Tech Stack:** React + TypeScript + Zustand + @tabler/icons-react; Vitest + Testing Library. Frontend root: `cmd/klyx/frontend/`.

**Spec:** `docs/superpowers/specs/2026-06-04-klyx-drill-in-navigation-design.md`

**All paths below are under `cmd/klyx/frontend/`. Run vitest from that dir.**

---

### Task 1: Route state in the store

**Files:**
- Modify: `src/store/fleet.ts`
- Test: `src/store/fleet.test.ts`

- [ ] **Step 1: Write the failing test** — `src/store/fleet.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleet";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("fleet store routing", () => {
  it("openCluster enters cluster scope on overview", () => {
    useFleet.getState().openCluster("homelab-nelli");
    expect(useFleet.getState().route).toEqual({ name: "cluster", cluster: "homelab-nelli", section: "overview" });
  });
  it("setSection changes section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    useFleet.getState().setSection("gitops");
    expect(useFleet.getState().route).toEqual({ name: "cluster", cluster: "x", section: "gitops" });
  });
  it("setSection is a no-op at the fleet root", () => {
    useFleet.getState().setSection("gitops");
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("openFleet returns to the grid", () => {
    useFleet.getState().openCluster("x");
    useFleet.getState().openFleet();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/store/fleet.test.ts` → FAIL (`openCluster`/`route` undefined).

- [ ] **Step 3: Extend `src/store/fleet.ts`** — keep the existing `ClusterDTO` type, replace the store definition:
```ts
import { create } from "zustand";

export type ClusterDTO = {
  name: string;
  state: string;
  reason: string;
  nodesReady: number;
  nodesTotal: number;
  pods: number;
  version: string;
  gitopsTier: string;
  gitopsReason: string;
  networkTier: string;
  networkReason: string;
  env: string;
  region: string;
  provider: string;
  group: string;
  ageSeconds: number;
};

export type ClusterSection = "overview" | "gitops" | "network" | "resources" | "observability";

export type Route =
  | { name: "fleet" }
  | { name: "cluster"; cluster: string; section: ClusterSection };

export const SECTION_LABELS: Record<ClusterSection, string> = {
  overview: "Overview",
  gitops: "GitOps",
  network: "Network",
  resources: "Resources",
  observability: "Observability",
};

type FleetState = {
  clusters: ClusterDTO[];
  setClusters: (c: ClusterDTO[]) => void;
  route: Route;
  openFleet: () => void;
  openCluster: (name: string) => void;
  setSection: (s: ClusterSection) => void;
};

export const useFleet = create<FleetState>((set) => ({
  clusters: [],
  setClusters: (clusters) => set({ clusters }),
  route: { name: "fleet" },
  openFleet: () => set({ route: { name: "fleet" } }),
  openCluster: (name) => set({ route: { name: "cluster", cluster: name, section: "overview" } }),
  setSection: (section) =>
    set((s) => (s.route.name === "cluster" ? { route: { ...s.route, section } } : {})),
}));
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/store/fleet.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/store/fleet.ts cmd/klyx/frontend/src/store/fleet.test.ts
git commit -m "$(printf 'feat: route state (fleet/cluster + section) in the fleet store\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Styled ThemeToggle

**Files:**
- Create: `src/chrome/ThemeToggle.tsx`
- Test: `src/chrome/ThemeToggle.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/chrome/ThemeToggle.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";

beforeEach(() => localStorage.clear());

describe("ThemeToggle", () => {
  it("flips data-theme on click", () => {
    const { getByRole } = render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => getByRole("button").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/chrome/ThemeToggle.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/chrome/ThemeToggle.tsx`**
```tsx
import { IconSun, IconMoon } from "@tabler/icons-react";
import { useTheme } from "../theme/ThemeProvider";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      title="Toggle theme"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0,
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        color: "var(--color-text-primary)", cursor: "pointer",
      }}
    >
      {theme === "light" ? <IconMoon size={16} stroke={1.5} /> : <IconSun size={16} stroke={1.5} />}
    </button>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/chrome/ThemeToggle.test.tsx` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/chrome/ThemeToggle.tsx cmd/klyx/frontend/src/chrome/ThemeToggle.test.tsx
git commit -m "$(printf 'feat: styled ThemeToggle icon button\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Sidebar (icon rail)

**Files:**
- Create: `src/chrome/Sidebar.tsx`
- Test: `src/chrome/Sidebar.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/chrome/Sidebar.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Sidebar } from "./Sidebar";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("Sidebar", () => {
  it("Fleet icon returns to the grid", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("Fleet").click();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
  it("a section icon is disabled at the fleet root", () => {
    const { getByLabelText } = render(<Sidebar />);
    expect((getByLabelText("GitOps") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a section icon sets the section in cluster scope", () => {
    useFleet.getState().openCluster("x");
    const { getByLabelText } = render(<Sidebar />);
    getByLabelText("GitOps").click();
    expect(useFleet.getState().route).toMatchObject({ name: "cluster", section: "gitops" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/chrome/Sidebar.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/chrome/Sidebar.tsx`**
```tsx
import {
  IconLayoutGrid, IconLayoutDashboard, IconStack2, IconGitBranch,
  IconRoute, IconChartLine, IconTerminal2, IconSettings,
} from "@tabler/icons-react";
import { useFleet, ClusterSection, SECTION_LABELS } from "../store/fleet";

const SECTION_ICONS: { section: ClusterSection; Icon: typeof IconLayoutDashboard }[] = [
  { section: "overview", Icon: IconLayoutDashboard },
  { section: "resources", Icon: IconStack2 },
  { section: "gitops", Icon: IconGitBranch },
  { section: "network", Icon: IconRoute },
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/chrome/Sidebar.test.tsx` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/chrome/Sidebar.tsx cmd/klyx/frontend/src/chrome/Sidebar.test.tsx
git commit -m "$(printf 'feat: sidebar rail with fleet + cluster-scoped section icons\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Breadcrumb + Header

**Files:**
- Create: `src/chrome/Breadcrumb.tsx`
- Create: `src/chrome/Header.tsx`
- Test: `src/chrome/Breadcrumb.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/chrome/Breadcrumb.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import { Breadcrumb } from "./Breadcrumb";

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("Breadcrumb", () => {
  it("shows Fleet at the root", () => {
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("Fleet")).toBeTruthy();
  });
  it("shows Fleet / cluster / Section and Fleet navigates back", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "homelab-nelli", section: "gitops" } });
    const { getByText } = render(<Breadcrumb />);
    expect(getByText("homelab-nelli")).toBeTruthy();
    expect(getByText("GitOps")).toBeTruthy();
    getByText("Fleet").click();
    expect(useFleet.getState().route).toEqual({ name: "fleet" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/chrome/Breadcrumb.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/chrome/Breadcrumb.tsx`**
```tsx
import { useFleet, SECTION_LABELS } from "../store/fleet";

const crumbBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  color: "var(--color-text-info)", font: "inherit",
};

export function Breadcrumb() {
  const route = useFleet((s) => s.route);
  const openFleet = useFleet((s) => s.openFleet);
  const setSection = useFleet((s) => s.setSection);

  if (route.name === "fleet") {
    return <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Fleet</span>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-text-tertiary)" }}>
      <button onClick={openFleet} style={crumbBtn}>Fleet</button>
      <span>/</span>
      <button onClick={() => setSection("overview")} style={{ ...crumbBtn, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
        {route.cluster}
      </button>
      {route.section !== "overview" && (
        <>
          <span>/</span>
          <span style={{ color: "var(--color-text-primary)" }}>{SECTION_LABELS[route.section]}</span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/chrome/Header.tsx`** (no separate unit test; covered by the Breadcrumb test + the Task 8 smoke):
```tsx
import { useFleet, SECTION_LABELS } from "../store/fleet";
import { Breadcrumb } from "./Breadcrumb";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const route = useFleet((s) => s.route);
  const clusters = useFleet((s) => s.clusters);
  const regions = new Set(clusters.map((c) => c.region).filter(Boolean));
  const title = route.name === "fleet" ? "Fleet" : SECTION_LABELS[route.section];

  return (
    <div style={{ padding: "10px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
      <Breadcrumb />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <div style={{ fontSize: 17, fontWeight: 500 }}>{title}</div>
        {route.name === "fleet" && clusters.length > 0 && (
          <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>
            {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
            {regions.size > 0 ? ` · ${regions.size} region${regions.size === 1 ? "" : "s"}` : ""}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <ThemeToggle />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass + build** — `npx vitest run src/chrome/` then `npm run build` → PASS + builds.

- [ ] **Step 6: Commit**
```bash
git add cmd/klyx/frontend/src/chrome/Breadcrumb.tsx cmd/klyx/frontend/src/chrome/Header.tsx cmd/klyx/frontend/src/chrome/Breadcrumb.test.tsx
git commit -m "$(printf 'feat: breadcrumb + header (title, count chip, theme toggle)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Capability-aware Placeholder

**Files:**
- Create: `src/chrome/Placeholder.tsx`
- Test: `src/chrome/Placeholder.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/chrome/Placeholder.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Placeholder } from "./Placeholder";
import type { ClusterDTO } from "../store/fleet";

const dto = (over: Partial<ClusterDTO>): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v1",
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0, ...over,
});

describe("Placeholder", () => {
  it("gitops Absent says no Flux/Argo", () => {
    const { getByText } = render(<Placeholder section="gitops" c={dto({ gitopsTier: "Absent" })} />);
    expect(getByText(/No Flux or Argo/i)).toBeTruthy();
  });
  it("gitops present says arrives in M3", () => {
    const { getByText } = render(<Placeholder section="gitops" c={dto({ gitopsTier: "Healthy" })} />);
    expect(getByText(/arrives in M3/i)).toBeTruthy();
  });
  it("resources says CRD browser arrives in M4", () => {
    const { getByText } = render(<Placeholder section="resources" c={dto({})} />);
    expect(getByText(/CRD browser arrives in M4/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/chrome/Placeholder.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/chrome/Placeholder.tsx`**
```tsx
import type { ClusterDTO, ClusterSection } from "../store/fleet";

function message(section: ClusterSection, c: ClusterDTO): string {
  switch (section) {
    case "gitops":
      return c.gitopsTier === "Absent"
        ? "No Flux or Argo installed on this cluster."
        : "GitOps reconciliation + inline drift arrives in M3.";
    case "network":
      return c.networkTier === "Absent"
        ? "No Gateway API or Cilium installed on this cluster."
        : "Gateway topology arrives in M5.";
    case "resources":
      return "CRD browser arrives in M4.";
    case "observability":
      return "Inline metrics arrive with the Prometheus client (M7).";
    default:
      return "";
  }
}

export function Placeholder({ section, c }: { section: ClusterSection; c: ClusterDTO }) {
  return (
    <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>
      {message(section, c)}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/chrome/Placeholder.test.tsx` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/chrome/Placeholder.tsx cmd/klyx/frontend/src/chrome/Placeholder.test.tsx
git commit -m "$(printf 'feat: capability-aware honest placeholders for unbuilt sections\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Cluster Overview

**Files:**
- Create: `src/cluster/Overview.tsx`
- Test: `src/cluster/Overview.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/cluster/Overview.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Overview } from "./Overview";
import type { ClusterDTO } from "../store/fleet";

const dto: ClusterDTO = {
  name: "homelab-nelli", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 58,
  version: "v1.36.1", gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "homelab", region: "", provider: "k3s", group: "", ageSeconds: 3,
};

describe("Overview", () => {
  it("renders summary fields from the DTO", () => {
    const { getByText } = render(<Overview c={dto} />);
    expect(getByText("homelab-nelli")).toBeTruthy();
    expect(getByText("v1.36.1")).toBeTruthy();
    expect(getByText("1/1")).toBeTruthy();
    expect(getByText("58")).toBeTruthy();
    expect(getByText("homelab")).toBeTruthy();
  });
  it("shows the reason for a failed cluster", () => {
    const { getByText } = render(<Overview c={{ ...dto, state: "Failed", reason: "connect timed out" }} />);
    expect(getByText(/connect timed out/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/cluster/Overview.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/cluster/Overview.tsx`**
```tsx
import type { ClusterDTO } from "../store/fleet";

const stateColor: Record<string, string> = {
  Synced: "var(--color-text-success)",
  Degraded: "var(--color-text-warning)",
  Stale: "var(--color-text-warning)",
  Connecting: "var(--color-text-info)",
  Failed: "var(--color-text-danger)",
  Unconnected: "var(--color-text-tertiary)",
};

export function Overview({ c }: { c: ClusterDTO }) {
  const tags = [c.env, c.region, c.provider, c.group].filter(Boolean);
  return (
    <div style={{ padding: "16px 20px", maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor[c.state] ?? "var(--color-text-tertiary)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 15 }}>{c.name}</span>
        {c.version && <Badge>{c.version}</Badge>}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        {tags.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      <Section title="Health">
        <Row label="state"><span style={{ color: stateColor[c.state] }}>{c.state}</span></Row>
        {c.reason && <Row label="reason">{c.reason}</Row>}
        <Row label="age">{c.ageSeconds}s ago</Row>
      </Section>

      <Section title="Capacity">
        <Row label="nodes">{c.nodesReady}/{c.nodesTotal}</Row>
        <Row label="pods">{c.pods}</Row>
      </Section>

      <Section title="Capabilities">
        <Row label="gitops">{c.gitopsTier}{c.gitopsReason ? ` — ${c.gitopsReason}` : ""}</Row>
        <Row label="network">{c.networkTier}{c.networkReason ? ` — ${c.networkReason}` : ""}</Row>
      </Section>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", fontSize: 11, padding: "1px 6px", borderRadius: 4 }}>{children}</span>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--color-text-tertiary)", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--color-text-tertiary)", width: 64 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/cluster/Overview.test.tsx` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/cluster/Overview.tsx cmd/klyx/frontend/src/cluster/Overview.test.tsx
git commit -m "$(printf 'feat: cluster Overview from existing DTO data\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: ClusterDetail (routes section + missing-cluster notice)

**Files:**
- Create: `src/cluster/ClusterDetail.tsx`
- Test: `src/cluster/ClusterDetail.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/cluster/ClusterDetail.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFleet } from "../store/fleet";
import type { ClusterDTO } from "../store/fleet";
import { ClusterDetail } from "./ClusterDetail";

const dto = (over: Partial<ClusterDTO>): ClusterDTO => ({
  name: "x", state: "Synced", reason: "", nodesReady: 1, nodesTotal: 1, pods: 1, version: "v9",
  gitopsTier: "Healthy", gitopsReason: "", networkTier: "Healthy", networkReason: "",
  env: "", region: "", provider: "", group: "", ageSeconds: 0, ...over,
});

beforeEach(() => useFleet.setState({ clusters: [], route: { name: "fleet" } }));

describe("ClusterDetail", () => {
  it("renders Overview for the selected cluster", () => {
    useFleet.setState({ clusters: [dto({ name: "x" })], route: { name: "cluster", cluster: "x", section: "overview" } });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText("v9")).toBeTruthy();
  });
  it("renders a placeholder for the gitops section", () => {
    useFleet.setState({ clusters: [dto({ name: "x", gitopsTier: "Healthy" })], route: { name: "cluster", cluster: "x", section: "gitops" } });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText(/arrives in M3/i)).toBeTruthy();
  });
  it("shows a notice when the cluster is gone", () => {
    useFleet.setState({ clusters: [], route: { name: "cluster", cluster: "ghost", section: "overview" } });
    const { getByText } = render(<ClusterDetail />);
    expect(getByText(/no longer in the fleet/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/cluster/ClusterDetail.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/cluster/ClusterDetail.tsx`**
```tsx
import { useFleet } from "../store/fleet";
import { Overview } from "./Overview";
import { Placeholder } from "../chrome/Placeholder";

export function ClusterDetail() {
  const route = useFleet((s) => s.route);
  const cluster = useFleet((s) =>
    s.route.name === "cluster" ? s.clusters.find((x) => x.name === s.route.cluster) : undefined,
  );

  if (route.name !== "cluster") return null;
  if (!cluster) {
    return (
      <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 13 }}>
        This cluster is no longer in the fleet.
      </div>
    );
  }
  return route.section === "overview"
    ? <Overview c={cluster} />
    : <Placeholder section={route.section} c={cluster} />;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/cluster/ClusterDetail.test.tsx` → PASS.

- [ ] **Step 5: Commit**
```bash
git add cmd/klyx/frontend/src/cluster/ClusterDetail.tsx cmd/klyx/frontend/src/cluster/ClusterDetail.test.tsx
git commit -m "$(printf 'feat: ClusterDetail routes section views + missing-cluster notice\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 8: Clickable cards + AppShell + wire-up + verify

**Files:**
- Modify: `src/fleet/ClusterCard.tsx` (+ its test)
- Modify: `src/fleet/FleetView.tsx` (drop the redundant heading)
- Create: `src/app/AppShell.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the failing card-click test** — append to `src/fleet/ClusterCard.test.tsx`:
```tsx
import { useFleet } from "../store/fleet";

it("drills into the cluster on click", () => {
  useFleet.setState({ route: { name: "fleet" } });
  const { getByText } = render(<ClusterCard c={base} />);
  getByText("plt-sea-prd-we-aks-01").click();
  expect(useFleet.getState().route).toMatchObject({ name: "cluster", cluster: "plt-sea-prd-we-aks-01" });
});
```
(`base` and the imports already exist in this test file from B-1.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/fleet/ClusterCard.test.tsx` → FAIL (no click handler).

- [ ] **Step 3: Make `ClusterCard` clickable** — in `src/fleet/ClusterCard.tsx`, add the store import and an `onClick` + pointer/hover on the outer `div`. Add at the top:
```tsx
import { useFleet } from "../store/fleet";
```
Change the component's outer wrapper to drill in on click. Replace the opening of the returned `<div>` (the card container) so it reads:
```tsx
export function ClusterCard({ c }: { c: ClusterDTO }) {
  const openCluster = useFleet((s) => s.openCluster);
  return (
    <div
      onClick={() => openCluster(c.name)}
      style={{
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-md)",
        padding: "10px 12px",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-border-secondary)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border-tertiary)")}
    >
```
(Keep the rest of the card body — the status dot, badges, stat grid, and footer — exactly as it is.)

- [ ] **Step 4: Drop the redundant heading in `src/fleet/FleetView.tsx`** — the Header now owns the title. Replace the file with:
```tsx
import { useFleet } from "../store/fleet";
import { ClusterCard } from "./ClusterCard";

export function FleetView() {
  const clusters = useFleet((s) => s.clusters);
  return (
    <div style={{ padding: "14px 16px" }}>
      {clusters.length === 0 ? (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No clusters connected yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {clusters.map((c) => <ClusterCard key={c.name} c={c} />)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/app/AppShell.tsx`**
```tsx
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
```

- [ ] **Step 6: Shrink `src/App.tsx`**
```tsx
import { useEffect } from "react";
import { AppShell } from "./app/AppShell";
import { initFleetBridge } from "./bridge/fleet";

export default function App() {
  useEffect(() => {
    let off = () => {};
    initFleetBridge().then((u) => (off = u)).catch((e) => console.error("bridge init", e));
    return () => off();
  }, []);
  return <AppShell />;
}
```

- [ ] **Step 7: Run the full suite + build** — from `cmd/klyx/frontend/`:
```bash
npx vitest run
npm run build
```
Expected: all tests pass (store, theme, sidebar, breadcrumb, placeholder, overview, clusterdetail, clustercard); the frontend builds.

- [ ] **Step 8: Best-effort dev-server smoke + native handoff** — if a reachable config exists, start `wails3 dev` (`export PATH="$HOME/go/bin:$PATH"`, `KLYX_CONFIG=$HOME/.config/klyx/fleet.yaml`) and, with the browser tools, confirm: a card renders, clicking it shows the Overview with breadcrumb `Fleet / <cluster>`, clicking the GitOps rail icon shows its placeholder, clicking the `Fleet` breadcrumb returns to the grid, and the theme toggle flips light/dark. Stop dev afterward. If unreachable, note it and defer to the user. In the report, give the user: `cd cmd/klyx && KLYX_CONFIG="$HOME/.config/klyx/fleet.yaml" wails3 dev` to confirm the drill-in in the native window.

- [ ] **Step 9: Commit**
```bash
git add cmd/klyx/frontend/src/fleet/ClusterCard.tsx cmd/klyx/frontend/src/fleet/ClusterCard.test.tsx cmd/klyx/frontend/src/fleet/FleetView.tsx cmd/klyx/frontend/src/app/AppShell.tsx cmd/klyx/frontend/src/App.tsx
git commit -m "$(printf 'feat: clickable cards drill into AppShell cluster detail\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- §2 routing model (Route + actions, no router) → Task 1. ✓
- §3 component structure (AppShell/Sidebar/Header/Breadcrumb/ThemeToggle/Placeholder/ClusterDetail/Overview), App shrinks, ClusterCard onClick, FleetView via AppShell → Tasks 2-8. ✓
- §4 sidebar (Fleet + cluster-scoped sections incl. explicit Overview/layout-dashboard, disabled at root, active highlight, inert terminal/settings), header (breadcrumb + count chip + title), styled ThemeToggle → Tasks 2,3,4. ✓
- §5 cluster detail (Overview from DTO; capability-aware placeholders; missing-cluster notice; live via selector) → Tasks 5,6,7. ✓
- §6 testing (store routing, sidebar, breadcrumb, placeholder, overview, clusterdetail, themetoggle, card click; build; dev-smoke + native handoff) → every task + Task 8. ✓

**Placeholder scan:** none — all code is complete; Task 8 Step 8's dev-smoke is explicitly best-effort with a documented native handoff (the agent can't see the native window), not a vague TODO.

**Type consistency:** `Route`/`ClusterSection`/`SECTION_LABELS`/`openFleet`/`openCluster`/`setSection` (Task 1) are consumed by Sidebar (3), Breadcrumb/Header (4), ClusterDetail (7), ClusterCard/AppShell (8). `ClusterDTO` fields used in Placeholder (5)/Overview (6) match the store type (1) and the Go DTO json tags. `Placeholder` props `{section, c}` (5) match the `ClusterDetail` call (7). `Overview` prop `{c}` (6) matches `ClusterDetail` (7). Tabler icon names are the standard `Icon<Name>` exports.
```
