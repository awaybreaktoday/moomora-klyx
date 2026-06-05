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
  protected?: boolean;
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
  suspended?: boolean;
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

export type CRDKindDTO = { kind: string; plural: string; scope: string; version: string; operator: string; shortNames: string[] };
export type CRDGroupDTO = { group: string; category: string; kinds: CRDKindDTO[] };
export type CRDCountDTO = { count: number; capped: boolean };
export type CRDGroupBy = "group" | "operator" | "scope" | "alphabetical";

export type CRDSlice = {
  cluster: string | null;
  groups: CRDGroupDTO[];
  loading: boolean;
  expanded: string[];
  counts: Record<string, CRDCountDTO>;
  groupBy: CRDGroupBy;
  search: string;
};

export const crdCountKey = (group: string, version: string, plural: string) => `${group}/${version}/${plural}`;

export type ActionStatus = { kind: "success" | "error"; message: string };

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
  actionStatus: ActionStatus | null;
  setActionStatus: (s: ActionStatus) => void;
  clearActionStatus: () => void;
  crd: CRDSlice;
  setCRDs: (cluster: string, groups: CRDGroupDTO[]) => void;
  setCRDLoading: (cluster: string) => void;
  clearCRDs: () => void;
  toggleCRDGroup: (group: string) => void;
  setCRDCount: (key: string, dto: CRDCountDTO) => void;
  setCRDGroupBy: (g: CRDGroupBy) => void;
  setCRDSearch: (s: string) => void;
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
  actionStatus: null,
  setActionStatus: (actionStatus) => set({ actionStatus }),
  clearActionStatus: () => set({ actionStatus: null }),
  crd: { cluster: null, groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "" },
  setCRDs: (cluster, groups) => set((s) => ({ crd: { ...s.crd, cluster, groups, loading: false } })),
  setCRDLoading: (cluster) => set((s) => ({ crd: { ...s.crd, cluster, groups: [], loading: true, expanded: [], counts: {} } })),
  clearCRDs: () => set({ crd: { cluster: null, groups: [], loading: false, expanded: [], counts: {}, groupBy: "group", search: "" } }),
  toggleCRDGroup: (group) => set((s) => ({
    crd: { ...s.crd, expanded: s.crd.expanded.includes(group) ? s.crd.expanded.filter((g) => g !== group) : [...s.crd.expanded, group] },
  })),
  setCRDCount: (key, dto) => set((s) => ({ crd: { ...s.crd, counts: { ...s.crd.counts, [key]: dto } } })),
  setCRDGroupBy: (groupBy) => set((s) => ({ crd: { ...s.crd, groupBy } })),
  setCRDSearch: (search) => set((s) => ({ crd: { ...s.crd, search } })),
}));
