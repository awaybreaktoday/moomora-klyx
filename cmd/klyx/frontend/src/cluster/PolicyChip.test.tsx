import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PolicyChip } from "./PolicyChip";
import type { PolicyRefDTO } from "../store/fleet";

const btp: PolicyRefDTO = {
  kind: "BackendTrafficPolicy", namespace: "apps", name: "btp",
  targetKind: "HTTPRoute", targetNamespace: "apps", targetName: "share", targetSectionName: "",
  summary: "retries + timeout",
  details: [{ key: "retries", value: "3" }, { key: "request timeout", value: "30s" }],
  inferred: false,
};

describe("PolicyChip", () => {
  it("renders the kind abbreviation + value-free summary", () => {
    const { getByText } = render(<PolicyChip p={btp} />);
    expect(getByText(/BTP/)).toBeTruthy();
    expect(getByText(/retries \+ timeout/)).toBeTruthy();
  });

  it("exposes the first detail rows as a tooltip title", () => {
    const { getByTitle } = render(<PolicyChip p={btp} />);
    expect(getByTitle(/retries: 3/)).toBeTruthy();
    expect(getByTitle(/request timeout: 30s/)).toBeTruthy();
  });

  it("falls back to kind/namespace/name when there are no details", () => {
    const { getByTitle } = render(<PolicyChip p={{ ...btp, details: [] }} />);
    expect(getByTitle(/BackendTrafficPolicy\/apps\/btp/)).toBeTruthy();
  });
});
