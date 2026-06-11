// Command index for the ⌘K palette. buildCommands flattens the *currently
// loaded* store state into a flat list of runnable commands. It indexes only
// what is already in memory — no fetching — so the palette is honest about
// "showing loaded data". Each command's run() performs the navigation (and any
// jump-to-resource bridge call) as a side effect.

import { useFleet, SECTION_LABELS, ClusterSection } from "../store/fleet";
import { openPodDetail } from "../bridge/pods";
import { openHelmRelease } from "../bridge/helm";
import { listPods } from "../bridge/pods";
import { toggleTheme } from "../theme/ThemeProvider";

export type FleetStore = ReturnType<typeof useFleet.getState>;

export type Command = {
  id: string;
  group: string;
  title: string;
  hint?: string;
  run: () => void;
};

// Section display order mirrors the sidebar groups (triage-first, GitOps in top five).
const SECTION_ORDER: ClusterSection[] = [
  "overview",
  "workloads",
  "pods",
  "events",
  "gitops",
  "helm",
  "network",
  "nodes",
  "resources",
  "crds",
];

export function buildCommands(s: FleetStore): Command[] {
  const cmds: Command[] = [];
  const route = s.route;
  const cluster = route.name === "cluster" ? route.cluster : null;

  // --- Clusters ---------------------------------------------------------------
  for (const c of s.clusters) {
    const hintParts = [c.env, c.region].filter(Boolean);
    cmds.push({
      id: `cluster:${c.name}`,
      group: "Clusters",
      title: c.name,
      hint: hintParts.join(" · ") || undefined,
      run: () => s.openCluster(c.name),
    });
  }
  cmds.push({
    id: "fleet",
    group: "Clusters",
    title: "Fleet overview",
    run: () => s.openFleet(),
  });
  cmds.push({
    id: "forwards",
    group: "Clusters",
    title: "Port-forwards",
    hint: (s.forwards?.length ?? 0) > 0 ? `${s.forwards.length} active` : undefined,
    run: () => s.openForwards(),
  });

  // --- Sections (only inside a cluster) --------------------------------------
  if (cluster) {
    for (const section of SECTION_ORDER) {
      cmds.push({
        id: `section:${section}`,
        group: "Sections",
        title: SECTION_LABELS[section],
        hint: cluster,
        run: () => s.setSection(section),
      });
    }
  }

  // --- Pods (when the slice is loaded) ---------------------------------------
  if (s.pods.items.length > 0 && s.pods.cluster) {
    const podCluster = s.pods.cluster;
    for (const p of s.pods.items) {
      cmds.push({
        id: `pod:${p.namespace}/${p.name}`,
        group: "Pods",
        title: `${p.namespace}/${p.name}`,
        hint: p.phase || p.rank,
        run: () => {
          s.setSection("pods");
          void openPodDetail(podCluster, p.namespace, p.name);
        },
      });
    }
  }

  // --- Workloads (when loaded) -----------------------------------------------
  if (s.workloads.items.length > 0) {
    for (const w of s.workloads.items) {
      const key = `${w.kind}/${w.namespace}/${w.name}`;
      cmds.push({
        id: `workload:${key}`,
        group: "Workloads",
        title: `${w.kind.toLowerCase()} ${w.namespace}/${w.name}`,
        hint: w.rank,
        run: () => {
          s.setSection("workloads");
          // Expand the target row if it isn't already (toggle is a flip).
          if (!useFleet.getState().workloads.expanded.includes(key)) {
            s.toggleWorkloadExpand(key);
          }
        },
      });
    }
  }

  // --- Helm releases (when loaded) -------------------------------------------
  if (s.helm.releases.length > 0 && s.helm.cluster) {
    const helmCluster = s.helm.cluster;
    for (const r of s.helm.releases) {
      cmds.push({
        id: `helm:${r.namespace}/${r.name}`,
        group: "Helm releases",
        title: `${r.namespace}/${r.name}`,
        hint: r.chart,
        run: () => {
          s.setSection("helm");
          void openHelmRelease(helmCluster, r.namespace, r.name);
        },
      });
    }
  }

  // --- Namespaces (from the loaded pods slice) -------------------------------
  if (s.pods.namespaces.length > 0 && s.pods.cluster) {
    const nsCluster = s.pods.cluster;
    for (const ns of s.pods.namespaces) {
      cmds.push({
        id: `ns:${ns}`,
        group: "Namespaces",
        title: ns,
        hint: "pods",
        run: () => {
          s.setSection("pods");
          void listPods(nsCluster, ns);
        },
      });
    }
  }

  // --- Theme ------------------------------------------------------------------
  cmds.push({
    id: "theme:toggle",
    group: "Theme",
    title: "toggle theme",
    run: () => {
      toggleTheme();
    },
  });

  return cmds;
}
