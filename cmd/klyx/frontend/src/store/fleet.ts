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

export type FluxResourceDTO = {
  kind: string;
  namespace: string;
  name: string;
  ready: string;
  message: string;
  revision: string;
  lastAppliedAgeSeconds: number;
  suspended: boolean;
  sourceKind: string;
  sourceName: string;
};

export type ConditionDTO = { type: string; status: string; reason: string; message: string };
export type InventoryEntryDTO = { group: string; version: string; kind: string; namespace: string; name: string };
export type ResourceDetailDTO = {
  kind: string;
  namespace: string;
  name: string;
  appliedRevision: string;
  attemptedRevision: string;
  applyFailed: boolean;
  conditions: ConditionDTO[];
  inventory: InventoryEntryDTO[];
};

export type GitOpsSlice = {
  cluster: string | null;
  resources: FluxResourceDTO[];
  loading: boolean;
  expandedKey: string | null;
  detail: ResourceDetailDTO | null;
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
  gitops: GitOpsSlice;
  setGitOps: (cluster: string, resources: FluxResourceDTO[]) => void;
  setGitOpsLoading: (cluster: string) => void;
  clearGitOps: () => void;
  expand: (key: string) => void;
  collapse: () => void;
  setDetail: (d: ResourceDetailDTO) => void;
};

export const useFleet = create<FleetState>((set) => ({
  clusters: [],
  setClusters: (clusters) => set({ clusters }),
  route: { name: "fleet" },
  openFleet: () => set({ route: { name: "fleet" } }),
  openCluster: (name) => set({ route: { name: "cluster", cluster: name, section: "overview" } }),
  setSection: (section) =>
    set((s) => (s.route.name === "cluster" ? { route: { ...s.route, section } } : {})),
  gitops: { cluster: null, resources: [], loading: false, expandedKey: null, detail: null },
  setGitOps: (cluster, resources) => set((s) => ({ gitops: { ...s.gitops, cluster, resources, loading: false } })),
  setGitOpsLoading: (cluster) => set((s) => ({ gitops: { ...s.gitops, cluster, resources: [], loading: true } })),
  clearGitOps: () => set({ gitops: { cluster: null, resources: [], loading: false, expandedKey: null, detail: null } }),
  expand: (key) => set((s) => ({ gitops: { ...s.gitops, expandedKey: key, detail: null } })),
  collapse: () => set((s) => ({ gitops: { ...s.gitops, expandedKey: null, detail: null } })),
  setDetail: (d) => set((s) => ({ gitops: { ...s.gitops, detail: d } })),
}));
