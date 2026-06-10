import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ForwardPopover } from "./ForwardPopover";

vi.mock("../bridge/forwards", () => ({
  startForward: vi.fn().mockResolvedValue(undefined),
}));
import { startForward } from "../bridge/forwards";

describe("ForwardPopover", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches startForward with the prefilled target and auto (0) local port", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <ForwardPopover cluster="dev" namespace="team" kind="Service" name="api-svc" prefillTargetPort={80} onClose={onClose} />,
    );
    fireEvent.click(getByTestId("forward-start"));
    // local left blank => 0 (ephemeral); kind/name/target carried through.
    expect(startForward).toHaveBeenCalledWith("dev", "team", "Service", "api-svc", 0, 80);
    expect(onClose).toHaveBeenCalled();
  });

  it("dispatches with an explicit local port when provided", () => {
    const { getByLabelText, getByTestId } = render(
      <ForwardPopover cluster="dev" namespace="team" kind="Pod" name="api" onClose={() => {}} />,
    );
    fireEvent.change(getByLabelText("target port"), { target: { value: "8080" } });
    fireEvent.change(getByLabelText("local port"), { target: { value: "9000" } });
    fireEvent.click(getByTestId("forward-start"));
    expect(startForward).toHaveBeenCalledWith("dev", "team", "Pod", "api", 9000, 8080);
  });

  it("does not dispatch when the target port is empty/invalid", () => {
    const { getByTestId } = render(
      <ForwardPopover cluster="dev" namespace="team" kind="Pod" name="api" onClose={() => {}} />,
    );
    // No target port entered: start is disabled, click is a no-op.
    fireEvent.click(getByTestId("forward-start"));
    expect(startForward).not.toHaveBeenCalled();
  });
});
