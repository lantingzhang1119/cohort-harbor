// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PropertyPanel } from "@/features/portal/editor/property-panel";
import type { PortalElement } from "@/features/portal/portal-scene";

const baseShape = {
  id: "shape-1",
  name: "三角形",
  x: 40,
  y: 60,
  width: 200,
  height: 140,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  type: "TRIANGLE" as const,
  fillEnabled: true,
  fill: "#DCEBFA",
  lastFillColor: "#DCEBFA",
  stroke: "#1E88E5",
  strokeWidth: 2,
  dash: "SOLID" as const,
  shadow: null,
};

function renderPanel(
  element: PortalElement,
  onCommit = vi.fn(),
) {
  render(
    <PropertyPanel
      element={element}
      assets={[]}
      onCommit={onCommit}
      onRename={vi.fn()}
      onHidden={vi.fn()}
      onLocked={vi.fn()}
    />,
  );
  return onCommit;
}

describe("closed shape fill controls", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes enable-fill toggle, fill color, and no-fill control", () => {
    renderPanel(baseShape);
    expect(screen.getByLabelText("启用填充")).toBeTruthy();
    expect(screen.getByLabelText("填充颜色")).toBeTruthy();
    expect(screen.getByRole("button", { name: "无填充" })).toBeTruthy();
  });

  it("disables fill without clearing stroke or using opacity", () => {
    const onCommit = renderPanel(baseShape);
    fireEvent.click(screen.getByRole("button", { name: "无填充" }));
    expect(onCommit).toHaveBeenCalledWith({
      fillEnabled: false,
      fill: null,
      lastFillColor: "#DCEBFA",
    });
    expect(onCommit.mock.calls.at(-1)?.[0]).not.toMatchObject({ opacity: 0 });
    expect(onCommit.mock.calls.at(-1)?.[0]).not.toMatchObject({ stroke: null });
  });

  it("restores lastFillColor when fill is re-enabled", () => {
    const hollow: PortalElement = {
      ...baseShape,
      fillEnabled: false,
      fill: null,
      lastFillColor: "#AABBCC",
    };
    const onCommit = renderPanel(hollow);
    expect(screen.getByRole("status", { name: "无填充" }).textContent).toContain("无填充");
    fireEvent.click(screen.getByLabelText("启用填充"));
    expect(onCommit).toHaveBeenCalledWith({
      fillEnabled: true,
      fill: "#AABBCC",
      lastFillColor: "#AABBCC",
    });
  });

  it("keeps stroke properties independent while editing fill", () => {
    const onCommit = renderPanel(baseShape);
    fireEvent.change(screen.getByLabelText("描边颜色"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("线型"), { target: { value: "DASHED" } });
    expect(onCommit).toHaveBeenCalledWith({ stroke: "#112233" });
    expect(onCommit).toHaveBeenCalledWith({ strokeWidth: 6 });
    expect(onCommit).toHaveBeenCalledWith({ dash: "DASHED" });
  });

  it("can disable and restore the border independently from fill", () => {
    const onCommit = renderPanel(baseShape);
    fireEvent.click(screen.getByLabelText("启用边框"));
    expect(onCommit).toHaveBeenCalledWith({ stroke: null });

    cleanup();
    const borderless = { ...baseShape, stroke: null } satisfies PortalElement;
    const restore = renderPanel(borderless);
    fireEvent.click(screen.getByLabelText("启用边框"));
    expect(restore).toHaveBeenCalledWith({ stroke: "#1E88E5" });
  });

  it("supports all closed shape types in the property panel", () => {
    for (const type of ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const) {
      cleanup();
      const element = {
        ...baseShape,
        id: type.toLowerCase(),
        type,
        ...(type === "ROUND_RECT" ? { cornerRadius: 16 } : {}),
      } as PortalElement;
      renderPanel(element);
      expect(screen.getByLabelText("启用填充")).toBeTruthy();
      expect(screen.getByRole("button", { name: "无填充" })).toBeTruthy();
    }
  });
});
