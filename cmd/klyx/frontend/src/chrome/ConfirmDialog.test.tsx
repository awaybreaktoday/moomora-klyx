import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("non-protected: confirm enabled immediately and fires onConfirm", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <ConfirmDialog title="Reconcile" cluster="dev-ne" detail="Kustomization flux-system/app" protected={false} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const btn = getByText("Confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("protected: confirm disabled until the cluster name is typed", () => {
    const onConfirm = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <ConfirmDialog title="Suspend" cluster="prd-we" detail="Kustomization flux-system/app" protected={true} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const btn = getByText("Confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(getByPlaceholderText("prd-we"), { target: { value: "prd-we" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel fires onCancel", () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      <ConfirmDialog title="Reconcile" cluster="dev-ne" detail="x" protected={false} onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
