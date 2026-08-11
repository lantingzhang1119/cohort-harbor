// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TextOverlay } from "@/features/portal/editor/text-overlay";
import type { PortalElement } from "@/features/portal/portal-scene";

const textElement: Extract<PortalElement, { type: "TEXT" }> = {
  id: "front-desk",
  name: "前台",
  type: "TEXT",
  x: 10,
  y: 20,
  width: 160,
  height: 48,
  rotation: 15,
  opacity: 1,
  zIndex: 0,
  locked: false,
  hidden: false,
  text: "前台",
  color: "#112233",
  fontFamily: "Noto Sans SC Variable",
  fontSize: 24,
  fontWeight: 500,
  lineHeight: 1.5,
  align: "LEFT",
  italic: true,
  underline: true,
  letterSpacing: 2,
  backgroundColor: "#FFF7ED",
  action: null,
};

function stage() {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 820,
    bottom: 500,
    width: 720,
    height: 450,
    toJSON: () => ({}),
  });
  return { container: () => container };
}

describe("TextOverlay", () => {
  afterEach(cleanup);

  it("matches the stage transform, bundled font, font size, line height and rotation", () => {
    render(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={0.5}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    expect(textarea.style.position).toBe("fixed");
    expect(textarea.style.left).toBe("105px");
    expect(textarea.style.top).toBe("60px");
    expect(textarea.style.width).toBe("80px");
    expect(textarea.style.height).toBe("24px");
    expect(textarea.style.fontFamily).toContain("Noto Sans SC Variable");
    expect(textarea.style.fontSize).toBe("12px");
    expect(textarea.style.lineHeight).toBe("1.5");
    expect(textarea.style.fontStyle).toBe("italic");
    expect(textarea.style.textDecoration).toBe("underline");
    expect(textarea.style.letterSpacing).toBe("1px");
    expect(textarea.style.backgroundColor).toBe("rgb(255, 247, 237)");
    expect(textarea.style.transform).toBe("rotate(15deg)");
    expect(textarea.style.borderWidth).toBe("0px");
    expect(textarea.style.outline).toContain("solid");
    expect(textarea.style.padding).toBe("0px");
    expect(textarea.style.boxSizing).toBe("content-box");
    expect(textarea.style.whiteSpace).toBe("pre-wrap");
    expect(textarea.style.overflowWrap).toBe("break-word");
  });

  it("keeps exact wrapping dimensions while tracking stage scroll and resize", () => {
    let left = 100;
    let top = 50;
    const container = document.createElement("div");
    container.getBoundingClientRect = () => ({
      x: left,
      y: top,
      left,
      top,
      right: left + 720,
      bottom: top + 450,
      width: 720,
      height: 450,
      toJSON: () => ({}),
    });
    render(
      <TextOverlay
        element={{
          ...textElement,
          text: "这是一段需要保持与画布文字完全一致换行宽度的长文本",
        }}
        stage={{ container: () => container }}
        zoom={0.5}
        onCommit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    expect(textarea.style.width).toBe("80px");
    expect(textarea.style.height).toBe("24px");

    left = 140;
    top = 90;
    fireEvent.scroll(window);
    expect(textarea.style.left).toBe("145px");
    expect(textarea.style.top).toBe("100px");

    left = 180;
    top = 120;
    fireEvent(window, new Event("resize"));
    expect(textarea.style.left).toBe("185px");
    expect(textarea.style.top).toBe("130px");
  });

  it("commits once on Enter and on blur", () => {
    const enterCommit = vi.fn();
    const { unmount } = render(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={1}
        onCommit={enterCommit}
        onCancel={() => undefined}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "新的前台" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(enterCommit).toHaveBeenCalledTimes(1);
    expect(enterCommit).toHaveBeenCalledWith("新的前台");
    unmount();

    const blurCommit = vi.fn();
    render(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={1}
        onCommit={blurCommit}
        onCancel={() => undefined}
      />,
    );
    const blurTextarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    fireEvent.change(blurTextarea, { target: { value: "失焦提交" } });
    fireEvent.blur(blurTextarea);
    expect(blurCommit).toHaveBeenCalledOnce();
    expect(blurCommit).toHaveBeenCalledWith("失焦提交");
  });

  it("cancels on Escape and preserves Shift+Enter for a newline", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={1}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    rerender(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={1}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑文字" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores Enter and Escape during Chinese IME composition, then commits once", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextOverlay
        element={textElement}
        stage={stage()}
        zoom={1}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "前台接待" } });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(textarea, { key: "Escape", keyCode: 229 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.blur(textarea);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("前台接待");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
