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

export type ResourceRef = { group: string; version: string; plural: string; kind: string; scope: string };
export type InstanceDTO = { namespace: string; name: string; created: string };
export type InstancesSlice = { ref: ResourceRef | null; rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string };

export type InstanceRef = { namespace: string; name: string };
export type EventDTO = { type: string; reason: string; message: string; count: number; lastSeen: string };
export type InstanceDetailDTO = { kind: string; namespace: string; name: string; created: string; labels: Record<string, string>; conditions: ConditionDTO[]; events: EventDTO[]; yaml: string };
export type InstanceDetailSlice = { ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean };

export type Route =
  | { name: "fleet" }
  | { name: "cluster"; cluster: string; section: ClusterSection; resource?: ResourceRef; instance?: InstanceRef; gateway?: GatewayRef };

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

export type GatewayRefDTO = { namespace: string; name: string; className: string; accepted: boolean; programmed: boolean };
export type GatewayListDTO = { gatewayAPIServed: boolean; gateways: GatewayRefDTO[] };
export type PolicyDetailDTO = { key: string; value: string };
export type PolicyRefDTO = { kind: string; namespace: string; name: string; targetKind: string; targetNamespace: string; targetName: string; targetSectionName: string; summary: string; details: PolicyDetailDTO[]; inferred: boolean; match: string };
export type ListenerDTO = { name: string; protocol: string; hostname: string; port: number };
export type MatchDTO = { pathType: string; pathValue: string; method: string };
export type BackendDTO = { kind: string; name: string; namespace: string; port: number; weight: number };
export type PodCountDTO = { ready: number; total: number; unknown: boolean };
export type ServiceNodeDTO = { namespace: string; name: string; type: string; port: number; resolved: boolean; global: boolean; meshClusters: string[]; meshUnconfirmed: boolean; policies: PolicyRefDTO[]; cnps: PolicyRefDTO[] };
export type GatewayNodeDTO = { namespace: string; name: string; className: string; listeners: ListenerDTO[]; accepted: boolean; programmed: boolean; policies: PolicyRefDTO[] };
export type RouteNodeDTO = { namespace: string; name: string; hostnames: string[]; matches: MatchDTO[]; accepted: boolean; resolvedRefs: boolean; backends: BackendDTO[]; services: ServiceNodeDTO[]; pods: PodCountDTO; policies: PolicyRefDTO[] };
export type TopologyDTO = { gateway: GatewayNodeDTO; routes: RouteNodeDTO[]; clusterPolicies?: PolicyRefDTO[]; warnings?: string[]; error?: string };
export type GatewayRef = { namespace: string; name: string };

export type NetworkSlice = {
  served: boolean;
  gateways: GatewayRefDTO[];
  listLoading: boolean;
  selected: GatewayRef | null;
  topology: TopologyDTO | null;
  topologyLoading: boolean;
  selectedRoute: string | null; // "<ns>/<name>"
};

export type MeshNodeDTO = { cluster: string; name: string; clusterId: number | null; state: string; present: boolean };
export type MeshEdgeDTO = { a: string; b: string; mutual: boolean };
export type MeshGraphDTO = { nodes: MeshNodeDTO[]; edges: MeshEdgeDTO[] };

export type ActionStatus = { kind: "success" | "error"; message: string };

type FleetState = {
  clusters: ClusterDTO[];
  setClusters: (c: ClusterDTO[]) => void;
  route: Route;
  openFleet: () => void;
  openCluster: (name: string) => void;
  setSection: (s: ClusterSection) => void;
  openResource: (ref: ResourceRef) => void;
  closeResource: () => void;
  instances: InstancesSlice;
  setInstancesLoading: (ref: ResourceRef) => void;
  setInstancePage: (items: InstanceDTO[], nextToken: string) => void;
  addInstancePage: (items: InstanceDTO[], nextToken: string) => void;
  setInstanceFilter: (s: string) => void;
  clearInstances: () => void;
  openInstance: (namespace: string, name: string) => void;
  closeInstance: () => void;
  instanceDetail: InstanceDetailSlice;
  setInstanceDetailLoading: (ref: InstanceRef) => void;
  setInstanceDetail: (d: InstanceDetailDTO) => void;
  clearInstanceDetail: () => void;
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
  openGateway: (namespace: string, name: string) => void;
  closeGateway: () => void;
  network: NetworkSlice;
  setGatewaysLoading: () => void;
  setGateways: (l: GatewayListDTO) => void;
  setTopologyLoading: (ref: GatewayRef) => void;
  setTopology: (t: TopologyDTO) => void;
  selectRoute: (key: string | null) => void;
  clearNetwork: () => void;
  mesh: MeshGraphDTO | null;
  setMesh: (m: MeshGraphDTO) => void;
};

export const useFleet = create<FleetState>((set) => ({
  clusters: [],
  setClusters: (clusters) => set({ clusters }),
  route: { name: "fleet" },
  openFleet: () => set({ route: { name: "fleet" } }),
  openCluster: (name) => set({ route: { name: "cluster", cluster: name, section: "overview" } }),
  setSection: (section) =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section } } : {})),
  openResource: (resource) =>
    set((s) =>
      s.route.name === "cluster"
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "resources", resource },
            instances: { ref: resource, rows: [], nextToken: "", loading: true, filter: "" },
          }
        : {}),
  closeResource: () =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section: "resources" } } : {})),
  instances: { ref: null, rows: [], nextToken: "", loading: false, filter: "" },
  setInstancesLoading: (ref) => set({ instances: { ref, rows: [], nextToken: "", loading: true, filter: "" } }),
  setInstancePage: (items, nextToken) => set((s) => ({ instances: { ...s.instances, rows: items, nextToken, loading: false } })),
  addInstancePage: (items, nextToken) => set((s) => ({ instances: { ...s.instances, rows: [...s.instances.rows, ...items], nextToken, loading: false } })),
  setInstanceFilter: (filter) => set((s) => ({ instances: { ...s.instances, filter } })),
  clearInstances: () => set({ instances: { ref: null, rows: [], nextToken: "", loading: false, filter: "" } }),
  openInstance: (namespace, name) =>
    set((s) =>
      s.route.name === "cluster" && s.route.resource
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "resources", resource: s.route.resource, instance: { namespace, name } },
            instanceDetail: { ref: { namespace, name }, detail: null, loading: true },
          }
        : {}),
  closeInstance: () =>
    set((s) =>
      s.route.name === "cluster"
        ? { route: { name: "cluster", cluster: s.route.cluster, section: s.route.section, resource: s.route.resource } }
        : {}),
  instanceDetail: { ref: null, detail: null, loading: false },
  setInstanceDetailLoading: (ref) => set({ instanceDetail: { ref, detail: null, loading: true } }),
  setInstanceDetail: (detail) => set((s) => ({ instanceDetail: { ...s.instanceDetail, detail, loading: false } })),
  clearInstanceDetail: () => set({ instanceDetail: { ref: null, detail: null, loading: false } }),
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
  openGateway: (namespace, name) =>
    set((s) =>
      s.route.name === "cluster"
        ? {
            route: { name: "cluster", cluster: s.route.cluster, section: "network", gateway: { namespace, name } },
            network: { ...s.network, selected: { namespace, name }, topology: null, topologyLoading: true, selectedRoute: null },
          }
        : {}),
  closeGateway: () =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section: "network" } } : {})),
  network: { served: false, gateways: [], listLoading: false, selected: null, topology: null, topologyLoading: false, selectedRoute: null },
  setGatewaysLoading: () => set((s) => ({ network: { ...s.network, listLoading: true } })),
  setGateways: (l) => set((s) => ({ network: { ...s.network, served: l.gatewayAPIServed, gateways: l.gateways ?? [], listLoading: false } })),
  setTopologyLoading: (ref) => set((s) => ({ network: { ...s.network, selected: ref, topology: null, topologyLoading: true, selectedRoute: null } })),
  setTopology: (topology) => set((s) => ({ network: { ...s.network, topology, topologyLoading: false } })),
  selectRoute: (selectedRoute) => set((s) => ({ network: { ...s.network, selectedRoute } })),
  clearNetwork: () => set((s) => ({ network: { ...s.network, selected: null, topology: null, topologyLoading: false, selectedRoute: null } })),
  mesh: null,
  setMesh: (mesh) => set({ mesh }),
}));
