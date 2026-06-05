import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useFleet, ResourceRef, InstanceRef, InstanceDetailDTO } from "../store/fleet";
import { InstanceDetail } from "./InstanceDetail";

vi.mock("../bridge/crd", () => ({ getInstanceDetail: vi.fn(async () => {}), copyText: vi.fn(async () => {}) }));
import { getInstanceDetail, copyText } from "../bridge/crd";

const resource: ResourceRef = { group: "cert-manager.io", version: "v1", plural: "certificates", kind: "Certificate", scope: "Namespaced" };
const instance: InstanceRef = { namespace: "default", name: "web-tls" };
const detail: InstanceDetailDTO = {
  kind: "Certificate", namespace: "default", name: "web-tls", created: "", labels: { app: "web" },
  conditions: [{ type: "Ready", status: "True", reason: "Issued", message: "Certificate is up to date" }],
  events: [{ type: "Warning", reason: "Failed", message: "order failed", count: 2, lastSeen: "" }],
  yaml: "apiVersion: cert-manager.io/v1\nkind: Certificate\n",
};

function seed(over: Partial<{ ref: InstanceRef | null; detail: InstanceDetailDTO | null; loading: boolean }> = {}) {
  useFleet.setState({ instanceDetail: { ref: instance, detail, loading: false, ...over } });
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
