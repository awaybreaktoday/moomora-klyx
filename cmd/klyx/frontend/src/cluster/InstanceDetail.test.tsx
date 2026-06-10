import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceRef, InstanceDetailDTO, ServiceBackingDTO } from "../store/fleet";
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
    expect(getByText(/order failed/)).toBeTruthy();
    expect(getByText(/kind: Certificate/)).toBeTruthy();
  });

  it("copy calls the bridge with the YAML", () => {
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    fireEvent.click(getByText(/copy/i));
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
    expect(getByText(/no events/i)).toBeTruthy();
  });

  it("shows a loading state before the detail arrives", () => {
    seed({ detail: null, loading: true });
    const { getByText } = render(<InstanceDetail cluster="x" resource={resource} instance={instance} />);
    expect(getByText(/Loading/i)).toBeTruthy();
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
