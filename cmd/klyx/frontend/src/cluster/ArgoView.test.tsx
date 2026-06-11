import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ArgoView } from "./ArgoView";
import { useFleet } from "../store/fleet";
import type { ArgoAppDTO } from "../store/fleet";

vi.mock("../bridge/argo", () => ({
  listArgoApps: vi.fn().mockResolvedValue(undefined),
  refreshArgoApp: vi.fn().mockResolvedValue(undefined),
  syncArgoApp: vi.fn().mockResolvedValue(undefined),
}));
import { listArgoApps, refreshArgoApp, syncArgoApp } from "../bridge/argo";

const healthy: ArgoAppDTO = {
  namespace: "argocd", name: "console-dev", project: "default",
  syncStatus: "Synced", healthStatus: "Healthy", broken: false,
  revision: "abc1234def5678", repoURL: "https://gitlab.com/x/workloads.git",
  path: "apps/console/overlays/dev", chart: "", targetRevision: "main",
  extraSources: 0, destNamespace: "console-dev", autoSync: true,
  opPhase: "Succeeded", opMessage: "", conditions: [],
  reconciledUnix: Math.floor(Date.now() / 1000) - 120,
};
const broken: ArgoAppDTO = {
  ...healthy, name: "ollama-prod", syncStatus: "OutOfSync", healthStatus: "Degraded",
  broken: true, destNamespace: "ollama-prod", autoSync: false,
  conditions: [{ type: "ComparisonError", message: "repo unreachable" }],
};

function seed(apps: ArgoAppDTO[], extra: Partial<{ available: boolean; message: string }> = {}) {
  useFleet.setState((s) => ({ argo: { ...s.argo, cluster: "homelab-nelli", apps, available: extra.available ?? true, message: extra.message ?? "", loading: false } }));
}

describe("ArgoView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFleet.getState().clearArgo();
  });

  it("lists apps in Argo vocabulary with sync + health columns", () => {
    seed([broken, healthy]);
    const { getByText, getAllByText } = render(<ArgoView cluster="homelab-nelli" />);
    expect(getByText("OutOfSync")).toBeTruthy();
    expect(getByText("Degraded")).toBeTruthy();
    expect(getByText("Synced")).toBeTruthy();
    expect(getByText("Healthy")).toBeTruthy();
    expect(getAllByText(/abc1234d/).length).toBeGreaterThanOrEqual(1); // shortened revision
    expect(getByText(/1 need attention/)).toBeTruthy();
  });

  it("unavailable renders the reason, never an empty healthy list", () => {
    seed([], { available: false, message: "Argo CD not detected (no applications.argoproj.io resource)" });
    const { getByText } = render(<ArgoView cluster="homelab-nelli" />);
    expect(getByText(/Argo CD not detected/)).toBeTruthy();
  });

  it("expanding a row shows source, conditions, and the action buttons", () => {
    seed([broken]);
    const { getByText, getAllByText, queryByText, getByRole } = render(<ArgoView cluster="homelab-nelli" />);
    expect(queryByText(/repo unreachable/)).toBeNull();
    fireEvent.click(getAllByText("ollama-prod")[0]);
    expect(getByText(/repo unreachable/)).toBeTruthy();
    expect(getByText(/apps\/console\/overlays\/dev/)).toBeTruthy();
    expect(getByText("refresh app")).toBeTruthy();
    expect(getByRole("button", { name: "sync" })).toBeTruthy();
  });

  it("sync flows through ConfirmDialog and dispatches with target revision", () => {
    seed([broken]);
    const { getAllByText, getAllByRole, getByRole } = render(<ArgoView cluster="homelab-nelli" />);
    fireEvent.click(getAllByText("ollama-prod")[0]); // expand (name cell; dest ns matches too)
    fireEvent.click(getByRole("button", { name: "sync" })); // open confirm
    const confirm = getAllByRole("button", { name: "Sync" });
    fireEvent.click(confirm[confirm.length - 1]);
    expect(syncArgoApp).toHaveBeenCalledWith("homelab-nelli", "argocd", "ollama-prod", "main");
  });

  it("refresh flows through ConfirmDialog", () => {
    seed([healthy]);
    const { getByText, getAllByText, getAllByRole } = render(<ArgoView cluster="homelab-nelli" />);
    fireEvent.click(getAllByText("console-dev")[0]); // name cell (dest ns matches too)
    fireEvent.click(getByText("refresh app"));
    const confirm = getAllByRole("button", { name: "Refresh" });
    fireEvent.click(confirm[confirm.length - 1]);
    expect(refreshArgoApp).toHaveBeenCalledWith("homelab-nelli", "argocd", "console-dev");
  });

  it("fetches on mount", () => {
    render(<ArgoView cluster="homelab-nelli" />);
    expect(listArgoApps).toHaveBeenCalledWith("homelab-nelli");
  });
});
