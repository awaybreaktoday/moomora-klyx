import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCommands, FleetStore } from "./commands";
import { useFleet } from "../store/fleet";

// Bridges hit the Wails runtime; stub them so run() is observable without it.
vi.mock("../bridge/pods", () => ({
  openPodDetail: vi.fn(),
  listPods: vi.fn(),
}));
vi.mock("../bridge/helm", () => ({
  openHelmRelease: vi.fn(),
}));
import { openPodDetail, listPods } from "../bridge/pods";
import { openHelmRelease } from "../bridge/helm";

// A FleetStore stub with spied actions; callers override only the slices they
// exercise. The real store has dozens of fields, so we cast through unknown.
function makeStore(over: Partial<FleetStore>): FleetStore {
  const base = {
    clusters: [],
    route: { name: "fleet" },
    openFleet: vi.fn(),
    openCluster: vi.fn(),
    setSection: vi.fn(),
    toggleWorkloadExpand: vi.fn(),
    pods: { cluster: null, items: [], namespaces: [] },
    workloads: { items: [], expanded: [] },
    helm: { cluster: null, releases: [] },
  };
  return { ...base, ...over } as unknown as FleetStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the real store (used by commands.ts for the live expanded read).
  useFleet.setState({ workloads: { ...useFleet.getState().workloads, expanded: [] } });
});

describe("buildCommands", () => {
  it("lists clusters plus a fleet-overview command", () => {
    const s = makeStore({
      clusters: [
        { name: "dev", env: "DEV", region: "westeurope" } as never,
        { name: "prd", env: "PRD", region: "northeurope" } as never,
      ],
    });
    const cmds = buildCommands(s);
    const clusterCmds = cmds.filter((c) => c.group === "Clusters");
    expect(clusterCmds.map((c) => c.title)).toEqual(["dev", "prd", "Fleet overview"]);
    expect(clusterCmds[0].hint).toBe("DEV · westeurope");
  });

  it("navigates to the cluster when a cluster command runs", () => {
    const openCluster = vi.fn();
    const s = makeStore({ clusters: [{ name: "dev", env: "DEV", region: "we" } as never], openCluster });
    const cmd = buildCommands(s).find((c) => c.id === "cluster:dev")!;
    cmd.run();
    expect(openCluster).toHaveBeenCalledWith("dev");
  });

  it("omits Sections when not inside a cluster", () => {
    const s = makeStore({ route: { name: "fleet" } });
    expect(buildCommands(s).some((c) => c.group === "Sections")).toBe(false);
  });

  it("includes Sections with cluster hint when inside a cluster", () => {
    const setSection = vi.fn();
    const s = makeStore({ route: { name: "cluster", cluster: "dev", section: "overview" } as never, setSection });
    const sections = buildCommands(s).filter((c) => c.group === "Sections");
    // 10 sections: observability removed; gitops label is "Flux" but id stays "gitops"
    expect(sections.length).toBe(10);
    expect(sections[0].hint).toBe("dev");
    // gitops section is still reachable by id
    sections.find((c) => c.id === "section:gitops")!.run();
    expect(setSection).toHaveBeenCalledWith("gitops");
    // gitops section title is "Flux" (design principle 8)
    expect(sections.find((c) => c.id === "section:gitops")!.title).toBe("Flux");
    // observability section is gone
    expect(sections.find((c) => c.id === "section:observability")).toBeUndefined();
    // triage-first order: overview, workloads, pods, events, gitops, helm, network, nodes, resources, crds
    const ids = sections.map((c) => c.id.replace("section:", ""));
    expect(ids).toEqual(["overview", "workloads", "pods", "events", "gitops", "helm", "network", "nodes", "resources", "crds"]);
  });

  it("omits Pods when the pods slice is empty", () => {
    const s = makeStore({ pods: { cluster: "dev", items: [], namespaces: [] } as never });
    expect(buildCommands(s).some((c) => c.group === "Pods")).toBe(false);
  });

  it("includes Pods when seeded and jumps to detail on run", () => {
    const setSection = vi.fn();
    const s = makeStore({
      setSection,
      pods: {
        cluster: "dev",
        namespaces: ["team"],
        items: [{ namespace: "team", name: "api-1", phase: "Running", rank: "healthy" }],
      } as never,
    });
    const cmds = buildCommands(s);
    const pod = cmds.find((c) => c.id === "pod:team/api-1")!;
    expect(pod.title).toBe("team/api-1");
    pod.run();
    expect(setSection).toHaveBeenCalledWith("pods");
    expect(openPodDetail).toHaveBeenCalledWith("dev", "team", "api-1");
  });

  it("includes a Namespaces command that lists pods for that namespace", () => {
    const s = makeStore({
      pods: { cluster: "dev", namespaces: ["team"], items: [{ namespace: "team", name: "api-1", phase: "Running", rank: "healthy" }] } as never,
    });
    const ns = buildCommands(s).find((c) => c.id === "ns:team")!;
    ns.run();
    expect(listPods).toHaveBeenCalledWith("dev", "team");
  });

  it("includes Helm releases that open detail on run", () => {
    const s = makeStore({
      helm: { cluster: "dev", releases: [{ namespace: "team", name: "redis", chart: "redis-18.0.0" }] } as never,
    });
    const cmd = buildCommands(s).find((c) => c.id === "helm:team/redis")!;
    cmd.run();
    expect(openHelmRelease).toHaveBeenCalledWith("dev", "team", "redis");
  });

  it("includes Workloads and expands the row on run", () => {
    const toggleWorkloadExpand = vi.fn();
    const s = makeStore({
      toggleWorkloadExpand,
      workloads: { items: [{ kind: "Deployment", namespace: "team", name: "api", rank: "healthy" }], expanded: [] } as never,
    });
    const cmd = buildCommands(s).find((c) => c.id === "workload:Deployment/team/api")!;
    expect(cmd.title).toBe("deployment team/api");
    cmd.run();
    expect(toggleWorkloadExpand).toHaveBeenCalledWith("Deployment/team/api");
  });

  it("always offers a theme toggle command", () => {
    const s = makeStore({});
    expect(buildCommands(s).some((c) => c.id === "theme:toggle")).toBe(true);
  });
});
