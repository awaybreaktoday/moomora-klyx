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

export type ClusterSection = "overview" | "gitops" | "network" | "resources" | "observability" | "workloads" | "pods" | "events";

export type OwnerDTO = { kind: string; namespace: string; name: string };
export type PodDTO = { name: string; ready: boolean; restarts: number; reason: string; node: string; ageSeconds: number };
export type ResourceCellDTO = { usage: number | null; request: number | null; limit: number | null };
export type WorkloadResourcesDTO = { cpu: ResourceCellDTO; mem: ResourceCellDTO };
export type WorkloadDTO = { kind: string; namespace: string; name: string; desired: number; ready: number; available: number; updated: number; restarts: number; reason: string; rank: "unhealthy"|"degraded"|"restarts"|"healthy"; gitops: OwnerDTO | null; pods: PodDTO[]; resources: WorkloadResourcesDTO };
export type WorkloadUsageDTO = { cpuUsage: number | null; memUsage: number | null };
export type WorkloadMetricsStatusDTO = { available: boolean; message: string; updatedAt: string };
export type WorkloadMetricsResultDTO = { status: WorkloadMetricsStatusDTO; usage: Record<string, WorkloadUsageDTO> };
export type WorkloadsResultDTO = { fluxPresent: boolean; namespaces: string[]; workloads: WorkloadDTO[] };
export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
export type WorkloadsSlice = {
  cluster: string | null;
  namespace: string;        // "" = all
  items: WorkloadDTO[];
  namespaces: string[];
  fluxPresent: boolean;
  loading: boolean;
  kindFilter: Record<WorkloadKind, boolean>;
  needsAttention: boolean;
  expanded: string[];       // keys "<kind>/<namespace>/<name>"
  metricsAvailable: boolean;
  metricsStatus: WorkloadMetricsStatusDTO | null;
  metricsStale: boolean;
  nearLimitSort: boolean;
};

export type ContainerSummaryDTO = { name: string; image: string; ready: boolean; restarts: number; state: string; init: boolean };
export type PodSummaryDTO = { namespace: string; name: string; ready: boolean; phase: string; reason: string; rank: "unhealthy"|"degraded"|"restarts"|"healthy"; restarts: number; node: string; ip: string; ownerKind: string; ownerName: string; ageSeconds: number; containers: ContainerSummaryDTO[] };
export type PodsResultDTO = { namespaces: string[]; pods: PodSummaryDTO[] };
export type PodDetailDTO = { summary: PodSummaryDTO; labels: Record<string, string>; conditions: ConditionDTO[]; events: EventDTO[]; yaml: string; qosClass: string; serviceAccount: string };

export type PodRef = { namespace: string; name: string };
export type PodsSlice = {
  cluster: string | null;
  namespace: string;
  items: PodSummaryDTO[];
  namespaces: string[];
  loading: boolean;
  needsAttention: boolean;
  search: string;
  selected: PodRef | null;
  detail: PodDetailDTO | null;
  detailLoading: boolean;
};

export type EventRowDTO = { type: "Normal" | "Warning"; reason: string; message: string; count: number; namespace: string; kind: string; name: string; lastSeenUnix: number; firstSeenUnix: number };
export type EventsResultDTO = { namespaces: string[]; events: EventRowDTO[] };
export type EventsSlice = {
  cluster: string | null;
  namespace: string;
  items: EventRowDTO[];
  namespaces: string[];
  loading: boolean;
  warningsOnly: boolean;
  search: string;
};

export type ResourceRef = { group: string; version: string; plural: string; kind: string; scope: string };
export type InstanceDTO = { namespace: string; name: string; created: string };
export type InstancesSlice = { ref: ResourceRef | null; rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string };

export type InstanceRef = { namespace: string; name: string };
export type EventDTO = { type: string; reason: string; message: string; count: number; lastSeen: string };
export type SecretKeyDTO = { key: string; bytes: number };
export type InstanceDetailDTO = { kind: string; namespace: string; name: string; created: string; labels: Record<string, string>; conditions: ConditionDTO[]; events: EventDTO[]; yaml: string; secretKeys?: SecretKeyDTO[] };
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
  workloads: "Workloads",
  pods: "Pods",
  events: "Events",
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

export type RouteMetricDTO = { rps: number | null; p50: number | null; p99: number | null; errRate: number | null };
export type RouteMetricsStatusDTO = { available: boolean; message: string; updatedAt: string };
export type RouteMetricsResultDTO = { status: RouteMetricsStatusDTO; routes: Record<string, RouteMetricDTO> };

export type NetworkSlice = {
  served: boolean;
  gateways: GatewayRefDTO[];
  listLoading: boolean;
  selected: GatewayRef | null;
  topology: TopologyDTO | null;
  topologyLoading: boolean;
  selectedRoute: string | null; // "<ns>/<name>"
  routeMetrics: Record<string, RouteMetricDTO>;
  routeMetricsStatus: RouteMetricsStatusDTO | null;
  routeMetricsStale: boolean;
};

export type MeshNodeDTO = { cluster: string; name: string; clusterId: number | null; state: string; present: boolean };
export type MeshEdgeDTO = { a: string; b: string; mutual: boolean };
export type MeshGraphDTO = { nodes: MeshNodeDTO[]; edges: MeshEdgeDTO[] };

export type MetricsDTO = { available: boolean; mode: string; source: string; warning: string; reason: string; cpuFraction: number | null; memFraction: number | null };
export type MetricsSlice = { cluster: string | null; dto: MetricsDTO | null; loading: boolean };

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
  setRouteMetrics: (result: RouteMetricsResultDTO) => void;
  mesh: MeshGraphDTO | null;
  setMesh: (m: MeshGraphDTO) => void;
  metrics: MetricsSlice;
  setMetricsLoading: (cluster: string) => void;
  setMetrics: (cluster: string, dto: MetricsDTO) => void;
  clearMetrics: () => void;
  workloads: WorkloadsSlice;
  setWorkloadsLoading: (cluster: string, namespace: string) => void;
  setWorkloads: (cluster: string, namespace: string, result: WorkloadsResultDTO) => void;
  toggleWorkloadKind: (k: WorkloadKind) => void;
  toggleNeedsAttention: () => void;
  toggleWorkloadExpand: (key: string) => void;
  setWorkloadUsage: (cluster: string, namespace: string, result: WorkloadMetricsResultDTO) => void;
  toggleNearLimitSort: () => void;
  clearWorkloads: () => void;
  pods: PodsSlice;
  setPodsLoading: (cluster: string, namespace: string) => void;
  setPods: (cluster: string, namespace: string, result: PodsResultDTO) => void;
  togglePodsNeedsAttention: () => void;
  setPodsSearch: (s: string) => void;
  selectPod: (ref: PodRef | null) => void;
  setPodDetail: (ref: PodRef, detail: PodDetailDTO) => void;
  clearPods: () => void;
  events: EventsSlice;
  setEventsLoading: (cluster: string, namespace: string) => void;
  setEvents: (cluster: string, namespace: string, result: EventsResultDTO) => void;
  toggleWarningsOnly: () => void;
  setEventsSearch: (s: string) => void;
  clearEvents: () => void;
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
            network: { ...s.network, selected: { namespace, name }, topology: null, topologyLoading: true, selectedRoute: null, routeMetrics: {}, routeMetricsStatus: null, routeMetricsStale: false },
          }
        : {}),
  closeGateway: () =>
    set((s) => (s.route.name === "cluster" ? { route: { name: "cluster", cluster: s.route.cluster, section: "network" } } : {})),
  network: { served: false, gateways: [], listLoading: false, selected: null, topology: null, topologyLoading: false, selectedRoute: null, routeMetrics: {}, routeMetricsStatus: null, routeMetricsStale: false },
  setGatewaysLoading: () => set((s) => ({ network: { ...s.network, listLoading: true } })),
  setGateways: (l) => set((s) => ({ network: { ...s.network, served: l.gatewayAPIServed, gateways: l.gateways ?? [], listLoading: false } })),
  setTopologyLoading: (ref) => set((s) => ({ network: { ...s.network, selected: ref, topology: null, topologyLoading: true, selectedRoute: null, routeMetrics: {}, routeMetricsStatus: null, routeMetricsStale: false } })),
  setTopology: (topology) => set((s) => ({ network: { ...s.network, topology, topologyLoading: false } })),
  selectRoute: (selectedRoute) => set((s) => ({ network: { ...s.network, selectedRoute } })),
  clearNetwork: () => set((s) => ({ network: { ...s.network, selected: null, topology: null, topologyLoading: false, selectedRoute: null, routeMetrics: {}, routeMetricsStatus: null, routeMetricsStale: false } })),
  setRouteMetrics: (result) =>
    set((s) => {
      if (result.status.available) {
        return { network: { ...s.network, routeMetrics: result.routes ?? {}, routeMetricsStatus: result.status, routeMetricsStale: false } };
      }
      // transient failure: keep last-good numbers + last-good updatedAt, mark stale
      const keptUpdatedAt = s.network.routeMetricsStatus?.updatedAt ?? "";
      return {
        network: {
          ...s.network,
          // keep s.network.routeMetrics as-is (do NOT blank)
          routeMetricsStatus: { ...result.status, updatedAt: keptUpdatedAt },
          routeMetricsStale: Object.keys(s.network.routeMetrics).length > 0,
        },
      };
    }),
  mesh: null,
  setMesh: (mesh) => set({ mesh }),
  metrics: { cluster: null, dto: null, loading: false },
  setMetricsLoading: (cluster) => set((s) => ({ metrics: { cluster, dto: s.metrics.cluster === cluster ? s.metrics.dto : null, loading: true } })),
  setMetrics: (cluster, dto) => set({ metrics: { cluster, dto, loading: false } }),
  clearMetrics: () => set({ metrics: { cluster: null, dto: null, loading: false } }),
  workloads: { cluster: null, namespace: "", items: [], namespaces: [], fluxPresent: false, loading: false,
    kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true }, needsAttention: false, expanded: [],
    metricsAvailable: false, metricsStatus: null, metricsStale: false, nearLimitSort: false },
  setWorkloadsLoading: (cluster, namespace) => set((s) => ({ workloads: { ...s.workloads, cluster, namespace, loading: true } })),
  setWorkloads: (cluster, namespace, result) => set((s) => {
    // namespace-list preservation: replace only on all-load; fallback to [namespace] if empty.
    let namespaces = s.workloads.namespaces;
    if (namespace === "") namespaces = result.namespaces ?? [];
    if (namespaces.length === 0 && namespace !== "") namespaces = [namespace];
    return { workloads: { ...s.workloads, cluster, namespace, items: result.workloads ?? [], namespaces, fluxPresent: result.fluxPresent, loading: false } };
  }),
  toggleWorkloadKind: (k) => set((s) => ({ workloads: { ...s.workloads, kindFilter: { ...s.workloads.kindFilter, [k]: !s.workloads.kindFilter[k] } } })),
  toggleNeedsAttention: () => set((s) => ({ workloads: { ...s.workloads, needsAttention: !s.workloads.needsAttention } })),
  toggleWorkloadExpand: (key) => set((s) => ({ workloads: { ...s.workloads, expanded: s.workloads.expanded.includes(key) ? s.workloads.expanded.filter((k) => k !== key) : [...s.workloads.expanded, key] } })),
  setWorkloadUsage: (cluster, namespace, result) =>
    set((s) => {
      if (s.workloads.cluster !== cluster || s.workloads.namespace !== namespace) return {};
      if (result.status.available) {
        const items = s.workloads.items.map((w) => {
          const u = result.usage[`${w.kind}/${w.namespace}/${w.name}`];
          if (!u) return w;
          return { ...w, resources: {
            cpu: { ...w.resources.cpu, usage: u.cpuUsage },
            mem: { ...w.resources.mem, usage: u.memUsage },
          } };
        });
        return { workloads: { ...s.workloads, items, metricsAvailable: true, metricsStatus: result.status, metricsStale: false } };
      }
      const keptUpdatedAt = s.workloads.metricsStatus?.updatedAt ?? "";
      return { workloads: { ...s.workloads, metricsStatus: { ...result.status, updatedAt: keptUpdatedAt }, metricsStale: s.workloads.metricsAvailable } };
    }),
  toggleNearLimitSort: () => set((s) => ({ workloads: { ...s.workloads, nearLimitSort: !s.workloads.nearLimitSort } })),
  clearWorkloads: () => set((s) => ({ workloads: { ...s.workloads, cluster: null, items: [], namespaces: [], expanded: [], needsAttention: false, namespace: "", kindFilter: { Deployment: true, StatefulSet: true, DaemonSet: true }, metricsAvailable: false, metricsStatus: null, metricsStale: false, nearLimitSort: false } })),
  pods: { cluster: null, namespace: "", items: [], namespaces: [], loading: false, needsAttention: false, search: "", selected: null, detail: null, detailLoading: false },
  setPodsLoading: (cluster, namespace) => set((s) => ({ pods: { ...s.pods, cluster, namespace, loading: true } })),
  setPods: (cluster, namespace, result) => set((s) => {
    let namespaces = s.pods.namespaces;
    if (namespace === "") namespaces = result.namespaces ?? [];
    if (namespaces.length === 0 && namespace !== "") namespaces = [namespace];
    return { pods: { ...s.pods, cluster, namespace, items: result.pods ?? [], namespaces, loading: false } };
  }),
  togglePodsNeedsAttention: () => set((s) => ({ pods: { ...s.pods, needsAttention: !s.pods.needsAttention } })),
  setPodsSearch: (search) => set((s) => ({ pods: { ...s.pods, search } })),
  selectPod: (ref) => set((s) => ({ pods: { ...s.pods, selected: ref, detail: null, detailLoading: ref !== null } })),
  setPodDetail: (ref, detail) => set((s) => {
    const sel = s.pods.selected;
    if (!sel || sel.namespace !== ref.namespace || sel.name !== ref.name) return {};
    return { pods: { ...s.pods, detail, detailLoading: false } };
  }),
  clearPods: () => set({ pods: { cluster: null, namespace: "", items: [], namespaces: [], loading: false, needsAttention: false, search: "", selected: null, detail: null, detailLoading: false } }),
  events: { cluster: null, namespace: "", items: [], namespaces: [], loading: false, warningsOnly: false, search: "" },
  setEventsLoading: (cluster, namespace) => set((s) => ({ events: { ...s.events, cluster, namespace, loading: true } })),
  setEvents: (cluster, namespace, result) => set((s) => {
    let namespaces = s.events.namespaces;
    if (namespace === "") namespaces = result.namespaces ?? [];
    if (namespaces.length === 0 && namespace !== "") namespaces = [namespace];
    return { events: { ...s.events, cluster, namespace, items: result.events ?? [], namespaces, loading: false } };
  }),
  toggleWarningsOnly: () => set((s) => ({ events: { ...s.events, warningsOnly: !s.events.warningsOnly } })),
  setEventsSearch: (search) => set((s) => ({ events: { ...s.events, search } })),
  clearEvents: () => set({ events: { cluster: null, namespace: "", items: [], namespaces: [], loading: false, warningsOnly: false, search: "" } }),
}));
