// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComponentPanel } from "@/features/portal/editor/component-panel";
import { PropertyPanel } from "@/features/portal/editor/property-panel";
import type { PortalElement } from "@/features/portal/portal-scene";

const freehand: Extract<PortalElement, { type: "FREEHAND" }> = {
  id: "freehand-1",
  name: "自由绘制",
  type: "FREEHAND",
  x: 100,
  y: 200,
  width: 160,
  height: 90,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  points: [0, 20, 40, 0, 90, 70, 160, 90],
  stroke: "#1E88E5",
  strokeWidth: 4,
  tension: 0.4,
  lineCap: "ROUND",
  lineJoin: "ROUND",
};

describe("freehand component and property panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes an independent freehand tool that is not a line dash option", () => {
    const onCreate = vi.fn();
    render(
      <ComponentPanel
        onCreate={onCreate}
        onUploadImage={vi.fn()}
      />,
    );

    const freehandButton = screen.getByRole("button", { name: /自由绘制/ });
    expect(freehandButton.getAttribute("data-component-type")).toBe("FREEHAND");
    fireEvent.click(freehandButton);
    expect(onCreate).toHaveBeenCalledWith("FREEHAND");

    // Line tool remains separate — freehand is not dash masquerading.
    expect(screen.getByRole("button", { name: /线条/ }).getAttribute("data-component-type")).toBe("LINE");
  });

  it("edits freehand stroke color, width, opacity, and tension", () => {
    const onCommit = vi.fn();
    render(
      <PropertyPanel
        element={freehand}
        assets={[]}
        onCommit={onCommit}
        onRename={vi.fn()}
        onHidden={vi.fn()}
        onLocked={vi.fn()}
      />,
    );

    expect(screen.getByText("自由画笔")).toBeTruthy();
    expect(screen.queryByLabelText("线型")).toBeNull();

    fireEvent.change(screen.getByLabelText("线条颜色"), { target: { value: "#112233" } });
    expect(onCommit).toHaveBeenCalledWith({ stroke: "#112233" });

    fireEvent.change(screen.getByLabelText("线宽"), { target: { value: "8" } });
    expect(onCommit).toHaveBeenCalledWith({ strokeWidth: 8 });

    fireEvent.change(screen.getByLabelText("透明度"), { target: { value: "50" } });
    expect(onCommit).toHaveBeenCalledWith({ opacity: 0.5 });

    fireEvent.change(screen.getByLabelText("平滑度"), { target: { value: "0.7" } });
    expect(onCommit).toHaveBeenCalledWith({ tension: 0.7 });

    expect(screen.getByText(/圆角端点/)).toBeTruthy();
    expect(screen.getByText(/圆角连接/)).toBeTruthy();
  });
});
