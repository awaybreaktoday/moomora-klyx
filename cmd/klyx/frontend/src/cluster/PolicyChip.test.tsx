import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PolicyChip, chipSummary } from "./PolicyChip";
import type { PolicyRefDTO } from "../store/fleet";

const btp: PolicyRefDTO = {
  kind: "BackendTrafficPolicy", namespace: "apps", name: "btp",
  targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "",
  summary: "retries + timeout",
  details: [{ key: "retries", value: "3" }, { key: "request timeout", value: "30s" }],
  inferred: false, match: "",
};

describe("chipSummary", () => {
  it("collapses 3+ features to first two + overflow count", () => {
    expect(chipSummary("retries + timeout + load balancer")).toBe("retries + timeout +1");
  });
  it("returns a single feature unchanged", () => {
    expect(chipSummary("cors")).toBe("cors");
  });
  it("returns two features unchanged", () => {
    expect(chipSummary("a + b")).toBe("a + b");
  });
});

describe("PolicyChip", () => {
  it("renders the kind abbreviation + value-free summary", () => {
    const { getByText } = render(<PolicyChip p={btp} />);
    expect(getByText(/BTP/)).toBeTruthy();
    expect(getByText(/retries \+ timeout/)).toBeTruthy();
  });

  it("shows a structured tooltip only while hovered", () => {
    const { getByText, queryByText } = render(<PolicyChip p={btp} />);
    // not in the DOM before hover
    expect(queryByText(/BackendTrafficPolicy apps\/btp/)).toBeNull();
    expect(queryByText(/retries: 3/)).toBeNull();
    // appears on mouseEnter
    fireEvent.mouseEnter(getByText(/BTP/));
    expect(getByText(/BackendTrafficPolicy apps\/btp/)).toBeTruthy();
    expect(getByText(/retries: 3/)).toBeTruthy();
    expect(getByText(/request timeout: 30s/)).toBeTruthy();
    // gone again on mouseLeave
    fireEvent.mouseLeave(getByText(/BTP/));
    expect(queryByText(/BackendTrafficPolicy apps\/btp/)).toBeNull();
  });

  it("tooltip falls back to kind/namespace/name when there are no details", () => {
    const { getByText, queryByText } = render(<PolicyChip p={{ ...btp, details: [] }} />);
    fireEvent.mouseEnter(getByText(/BTP/));
    expect(getByText(/BackendTrafficPolicy apps\/btp/)).toBeTruthy();
    expect(queryByText(/retries: 3/)).toBeNull();
  });
});

const cnp: PolicyRefDTO = {
  kind: "CiliumNetworkPolicy", namespace: "apps", name: "share-allow",
  targetKind: "Pods", targetNamespace: "apps", targetName: "share-api", targetSectionName: "",
  summary: "ingress + egress", details: [{ key: "L7", value: "http" }],
  inferred: true, match: "selector",
};

describe("PolicyChip inferred (Cilium)", () => {
  it("renders the CNP abbreviation, ~ marker, and a dashed border", () => {
    const { getByText, container } = render(<PolicyChip p={cnp} />);
    expect(getByText(/CNP/)).toBeTruthy();
    expect(getByText("~")).toBeTruthy();
    // the inner chip span carries a dashed border when inferred
    const dashed = container.querySelector('span[style*="dashed"]');
    expect(dashed).toBeTruthy();
  });

  it("tooltip leads with the inference honesty note + match basis", () => {
    const { getByText } = render(<PolicyChip p={cnp} />);
    fireEvent.mouseEnter(getByText(/CNP/));
    expect(getByText(/inferred: matched by Service selector, not a Gateway API attachment/i)).toBeTruthy();
    expect(getByText(/via: selector/i)).toBeTruthy();
  });
});
