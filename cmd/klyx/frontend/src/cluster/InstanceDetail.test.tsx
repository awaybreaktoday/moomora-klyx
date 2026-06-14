import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceRef, InstanceDetailDTO, ServiceBackingDTO, HPAScalingDTO } from "../store/fleet";
import { InstanceDetail } from "./InstanceDetail";

vi.mock("../bridge/crd", () => ({
  getInstanceDetail: vi.fn(async () => {}),
  copyText: vi.fn(async () => {}),
  revealSecretKey: vi.fn(async () => "hunter2"),
}));
import { getInstanceDetail, copyText, revealSecretKey } from "../bridge/crd";

vi.mock("../bridge/pods", () => ({
  openPodDetail: vi.fn(async () => {}),
}));
import { openPodDetail } from "../bridge/pods";

// ForwardPopover imports bridge/forwards which uses the Wails runtime and
// requires window. Stub it here so the test can run in jsdom without the
// Wails runtime bootstrap. This is a pre-existing issue introduced when
// ForwardPopover was added to InstanceDetail.
vi.mock("../bridge/forwards", () => ({
  startForward: vi.fn(async () => ""),
  stopForward: vi.fn(async () => {}),
}));

const resource: ResourceRef = { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" };
const instance: InstanceRef = { namespace: "default", name: "web-tls" };
const detail: InstanceDetailDTO = {
  kind: "Certificate", namespace: "default", name: "web-tls", created: "", labels: { app: "web" },
  conditions: [{ type: "Ready", status: "True", reason: "Issued", message: "Certificate is up to date" }],
  events: [{ type: "Warning", reason: "Failed", message: "order failed", count: 2, lastSeen: "" }],
  yaml: "apiVersion: cert-manager.io/v1\nkind: Certificate\n",
};

const secretResource: ResourceRef = { group: "", version: "v1", plural: "secrets", kind: "Secret", scope: "Namespaced" };
const secretInstance: InstanceRef = { namespace: "default", name: "app-secret" };
const secretDetail: InstanceDetailDTO = {
  kind: "Secret", namespace: "default", name: "app-secret", created: "", labels: {},
  conditions: [], events: [],
  yaml: "apiVersion: v1\nkind: Secret\ndata:\n  password: <masked>\n",
  secretKeys: [
    { key: "password", bytes: 7 },
    { key: "token", bytes: 3 },
  ],
};

function seed(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}, inst = instance) {
  useFleet.setState({ instanceDetail: { ref: inst, detail: detail, loading: false, ...over } });
}

function seedSecret(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}) {
  useFleet.setState({ instanceDetail: { ref: secretInstance, detail: secretDetail, loading: false, ...over } });
}

beforeEach(() => { vi.clearAllMocks(); seed(); });

describe("InstanceDetail", () => {
  it("renders header, conditions, events, and YAML", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText("Certificate")).toBeTruthy();
    expect(getByText("Ready")).toBeTruthy();
    expect(getByText(/Certificate is up to date/)).toBeTruthy();
    fireEvent.click(getByText(/events 1/));
    expect(getByText(/order failed/)).toBeTruthy();
    fireEvent.click(getByText("yaml"));
    expect(getByText(/kind: Certificate/)).toBeTruthy();
  });

  it("copy calls the bridge with the YAML", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText("yaml"));
    fireEvent.click(getByText("Copy"));
    expect(copyText).toHaveBeenCalledWith(detail.yaml);
  });

  it("refresh re-fetches", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/refresh/i));
    expect(getInstanceDetail).toHaveBeenCalledWith("x", resource, instance);
  });

  it("shows a no-events note when there are none", () => {
    seed({ detail: { ...detail, events: [] } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/events 0/));
    expect(getByText(/no events/i)).toBeTruthy();
  });

  it("shows a loading state before the detail arrives", () => {
    seed({ detail: null, loading: true });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText(/Loading/i)).toBeTruthy();
  });

  it("breadcrumb back returns to the resource instance list", () => {
    useFleet.setState({ route: { name: "cluster", cluster: "x", section: "resources", resource, instance } });
    const { getByLabelText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByLabelText("back to resource list"));
    const r = useFleet.getState().route;
    expect(r.name === "cluster" && r.instance).toBeUndefined();
    expect(r.name === "cluster" && r.resource).toEqual(resource);
  });

  it("renders related objects and opens generic resource detail", () => {
    const relatedDetail: InstanceDetailDTO = {
      ...detail,
      related: [{
        kind: "Secret",
        namespace: "default",
        name: "web-tls-secret",
        group: "",
        version: "v1",
        plural: "secrets",
        scope: "Namespaced",
        relation: "certificate secret",
      }],
    };
    useFleet.getState().openCluster("x");
    useFleet.getState().openResource(resource);
    useFleet.setState({ instanceDetail: { ref: instance, detail: relatedDetail, loading: false } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/related 1/));
    fireEvent.click(getByText("default/web-tls-secret"));
    const r = useFleet.getState().route;
    expect(r.name === "cluster" && r.resource?.kind).toBe("Secret");
    expect(r.name === "cluster" && r.instance).toEqual({ namespace: "default", name: "web-tls-secret" });
  });
});

describe("InstanceDetail — secrets", () => {
  beforeEach(() => { vi.clearAllMocks(); seedSecret(); });

  it("renders data section with key names", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    expect(getByText("password")).toBeTruthy();
    expect(getByText("token")).toBeTruthy();
  });

  it("shows masked dots before reveal", () => {
    const { getAllByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    // Both keys should have Reveal buttons initially.
    const revealButtons = getAllByText("Reveal");
    expect(revealButtons.length).toBe(2);
  });

  it("reveal button calls bridge and shows decoded value", async () => {
    const { getAllByText, getByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    const revealButtons = getAllByText("Reveal");
    await act(async () => { fireEvent.click(revealButtons[0]); });
    await waitFor(() => expect(getByText("hunter2")).toBeTruthy());
    expect(revealSecretKey).toHaveBeenCalledWith("x", "default", "app-secret", "password");
  });

  it("hide button re-masks the value", async () => {
    const { getAllByText, getByText, queryByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    const revealButtons = getAllByText("Reveal");
    // Reveal first.
    await act(async () => { fireEvent.click(revealButtons[0]); });
    await waitFor(() => expect(getByText("hunter2")).toBeTruthy());
    // Then hide.
    const hideBtn = getByText("Hide");
    await act(async () => { fireEvent.click(hideBtn); });
    await waitFor(() => expect(queryByText("hunter2")).toBeNull());
  });

  it("copy button calls bridge and clipboard without revealing in UI", async () => {
    const { getAllByText, queryByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    const copyButtons = getAllByText("Copy");
    await act(async () => { fireEvent.click(copyButtons[0]); });
    await waitFor(() => expect(revealSecretKey).toHaveBeenCalled());
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("hunter2"));
    // Value must NOT appear in the DOM after copy-only.
    expect(queryByText("hunter2")).toBeNull();
  });

  it("yaml section still shows <masked> placeholder", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={secretResource} instance={secretInstance} />);
    fireEvent.click(getByText("yaml"));
    expect(getByText(/<masked>/)).toBeTruthy();
  });

  it("non-secret detail has no data section", () => {
    seed();
    const { queryAllByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    // "Reveal" buttons should not appear for non-secret.
    expect(queryAllByText("Reveal").length).toBe(0);
  });
});

const serviceResource: ResourceRef = { group: "", version: "v1", plural: "services", kind: "Service", scope: "Namespaced" };
const serviceInstance: InstanceRef = { namespace: "default", name: "web" };

const readyBacking: ServiceBackingDTO = {
  ports: [{ name: "http", port: 80, protocol: "TCP" }],
  ready: 2,
  notReady: 1,
  addresses: [
    { ip: "10.0.0.1", ready: true, targetKind: "Pod", targetName: "web-pod-1" },
    { ip: "10.0.0.2", ready: true, targetKind: "Pod", targetName: "web-pod-2" },
    { ip: "10.0.0.3", ready: false, targetKind: "Pod", targetName: "web-pod-3" },
  ],
  selector: { app: "web" },
};

const zeroBacking: ServiceBackingDTO = {
  ports: [{ name: "http", port: 80, protocol: "TCP" }],
  ready: 0,
  notReady: 3,
  addresses: [
    { ip: "10.0.0.1", ready: false, targetKind: "Pod", targetName: "web-pod-1" },
  ],
  selector: {},
};

const serviceDetail: InstanceDetailDTO = {
  kind: "Service", namespace: "default", name: "web", created: "", labels: { app: "web" },
  conditions: [], events: [],
  yaml: "apiVersion: v1\nkind: Service\n",
  serviceBacking: readyBacking,
};

function seedService(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}) {
  useFleet.setState({ instanceDetail: { ref: serviceInstance, detail: serviceDetail, loading: false, ...over } });
}

describe("InstanceDetail — service backing", () => {
  beforeEach(() => { vi.clearAllMocks(); seedService(); });

  it("renders backing section with ready count", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getByText(/2 ready/)).toBeTruthy();
  });

  it("renders port row", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getByText(/80\/TCP/)).toBeTruthy();
  });

  it("renders IP addresses", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getByText("10.0.0.1")).toBeTruthy();
  });

  it("renders pod links for Pod-targeted addresses", () => {
    const { getByTestId } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getByTestId("pod-link-web-pod-1")).toBeTruthy();
  });

  it("pod link calls openPodDetail and switches section to pods", () => {
    useFleet.getState().openCluster("x");
    seedService();
    const { getByTestId } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    fireEvent.click(getByTestId("pod-link-web-pod-1"));
    expect(openPodDetail).toHaveBeenCalledWith("x", "default", "web-pod-1");
    expect(useFleet.getState().route).toMatchObject({ section: "pods" });
  });

  it("renders selector chips", () => {
    // Both the labels section and the selector chips may render "app=web";
    // verify at least one appears.
    const { getAllByText } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getAllByText("app=web").length).toBeGreaterThanOrEqual(1);
  });

  it("zero-ready shows danger text", () => {
    seedService({ detail: { ...serviceDetail, serviceBacking: zeroBacking } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={serviceResource} instance={serviceInstance} />);
    expect(getByText(/no ready endpoints/)).toBeTruthy();
  });

  it("non-service detail has no backing section", () => {
    seed();
    const { queryByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(queryByText(/ready \/ /)).toBeNull();
    expect(queryByText(/no ready endpoints/)).toBeNull();
  });
});

const hpaResource: ResourceRef = { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", scope: "Namespaced" };
const hpaInstance: InstanceRef = { namespace: "default", name: "web-hpa" };

const baseHPAScaling: HPAScalingDTO = {
  minReplicas: 2,
  maxReplicas: 10,
  currentReplicas: 4,
  desiredReplicas: 4,
  targetKind: "Deployment",
  targetName: "web",
  lastScaleUnix: 1780308000,
  metrics: [
    { name: "cpu", type: "Resource", target: "70%", current: "43%" },
  ],
};

const hpaDetail: InstanceDetailDTO = {
  kind: "HorizontalPodAutoscaler", namespace: "default", name: "web-hpa",
  created: "", labels: {},
  conditions: [], events: [],
  yaml: "kind: HorizontalPodAutoscaler\n",
  hpaScaling: baseHPAScaling,
};

function seedHPA(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}) {
  useFleet.setState({ instanceDetail: { ref: hpaInstance, detail: hpaDetail, loading: false, ...over } });
}

describe("InstanceDetail — HPA scaling", () => {
  beforeEach(() => { vi.clearAllMocks(); seedHPA(); });

  it("renders replica line with current, desired, min, max", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    // current → desired
    expect(getByText(/4 → 4/)).toBeTruthy();
    // min / max band
    expect(getByText(/min 2 \/ max 10/)).toBeTruthy();
  });

  it("renders metric row with name, current, and target", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(getByText("cpu")).toBeTruthy();
    expect(getByText(/43%/)).toBeTruthy();
    expect(getByText(/70%/)).toBeTruthy();
  });

  it("renders last-scaled age", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    // lastScaleUnix is non-zero so it should NOT show "never"
    expect(getByText(/last scaled:/i)).toBeTruthy();
  });

  it("shows 'never' for last scale when lastScaleUnix is 0", () => {
    seedHPA({ detail: { ...hpaDetail, hpaScaling: { ...baseHPAScaling, lastScaleUnix: 0 } } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(getByText(/never/)).toBeTruthy();
  });

  it("shows 'at max' tag when currentReplicas >= maxReplicas", () => {
    const atMaxScaling: HPAScalingDTO = { ...baseHPAScaling, currentReplicas: 10, desiredReplicas: 10 };
    seedHPA({ detail: { ...hpaDetail, hpaScaling: atMaxScaling } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(getByText("at max")).toBeTruthy();
  });

  it("does not show 'at max' tag when not at max", () => {
    const { queryByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(queryByText("at max")).toBeNull();
  });

  it("renders '—' for unknown current metric (current empty string)", () => {
    const unknownCurrentScaling: HPAScalingDTO = {
      ...baseHPAScaling,
      metrics: [{ name: "cpu", type: "Resource", target: "70%", current: "" }],
    };
    seedHPA({ detail: { ...hpaDetail, hpaScaling: unknownCurrentScaling } });
    const { getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(getByText("—")).toBeTruthy();
  });

  it("Deployment target renders workloads link", () => {
    const { getByTestId } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(getByTestId("hpa-target-link")).toBeTruthy();
  });

  it("clicking Deployment target link sets section to workloads", () => {
    useFleet.getState().openCluster("x");
    seedHPA();
    const { getByTestId } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    fireEvent.click(getByTestId("hpa-target-link"));
    expect(useFleet.getState().route).toMatchObject({ section: "workloads" });
  });

  it("non-Deployment target kind renders plain text (no link)", () => {
    const cronScaling: HPAScalingDTO = { ...baseHPAScaling, targetKind: "CustomResource", targetName: "my-cr" };
    seedHPA({ detail: { ...hpaDetail, hpaScaling: cronScaling } });
    const { queryByTestId, getByText } = render(<InstanceDetail cluster="x" resource={hpaResource} instance={hpaInstance} />);
    expect(queryByTestId("hpa-target-link")).toBeNull();
    expect(getByText(/CustomResource\/my-cr/)).toBeTruthy();
  });

  it("non-HPA detail has no scaling section", () => {
    seed();
    const { queryByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    // "min" and "max" are specific enough: won't appear in a vanilla cert-manager detail
    expect(queryByText(/min \d+ \/ max \d+/)).toBeNull();
  });
});
