import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceDTO } from "../store/fleet";
import { InstanceList } from "./InstanceList";

vi.mock("../bridge/crd", () => ({ loadInstances: vi.fn(async () => {}) }));
import { loadInstances } from "../bridge/crd";

const nsRef: ResourceRef = { group: "cilium.io", version: "v2", plural: "ciliumendpoints", kind: "CiliumEndpoint", scope: "Namespaced" };
const clusterRef: ResourceRef = { group: "cilium.io", version: "v2", plural: "ciliumnodes", kind: "CiliumNode", scope: "Cluster" };
const rows: InstanceDTO[] = [
  { namespace: "kube-system", name: "coredns-abc", created: "" },
  { namespace: "monitoring", name: "prometheus-0", created: "" },
];

function seed(ref: ResourceRef, over: Partial<{ rows: InstanceDTO[]; nextToken: string; loading: boolean; filter: string }> = {}) {
  useFleet.setState({ instances: { ref, rows, nextToken: "", loading: false, filter: "", ...over } });
}

beforeEach(() => { vi.clearAllMocks(); seed(nsRef); });

describe("InstanceList", () => {
  it("renders rows with namespace for a namespaced kind", () => {
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(getByText("coredns-abc")).toBeTruthy();
    expect(getByText("kube-system")).toBeTruthy();
  });

  it("omits the namespace column for a cluster-scoped kind", () => {
    seed(clusterRef, { rows: [{ namespace: "", name: "node-1", created: "" }] });
    const { getByText, queryByText } = render(<InstanceList cluster="x" resource={clusterRef} />);
    expect(getByText("node-1")).toBeTruthy();
    expect(queryByText("namespace")).toBeNull();
  });

  it("shows Load more only when nextToken is set and calls the bridge with it", () => {
    seed(nsRef, { nextToken: "tok-2" });
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    fireEvent.click(getByText(/load more/i));
    expect(loadInstances).toHaveBeenCalledWith("x", nsRef, "tok-2");
  });

  it("hides Load more when there is no nextToken", () => {
    const { queryByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(queryByText(/load more/i)).toBeNull();
  });

  it("filters rows by substring", () => {
    seed(nsRef, { filter: "prometheus" });
    const { queryByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(queryByText("prometheus-0")).toBeTruthy();
    expect(queryByText("coredns-abc")).toBeNull();
  });

  it("shows the empty state when there are no rows and not loading", () => {
    seed(nsRef, { rows: [] });
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    expect(getByText(/No instances/i)).toBeTruthy();
  });

  it("clicking a row opens the instance detail", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource: nsRef } });
    seed(nsRef);
    const { getByText } = render(<InstanceList cluster="x" resource={nsRef} />);
    fireEvent.click(getByText("coredns-abc"));
    const r = useFleet.getState().route;
    expect(r.name === "cluster" && r.instance).toEqual({ namespace: "kube-system", name: "coredns-abc" });
  });
});
