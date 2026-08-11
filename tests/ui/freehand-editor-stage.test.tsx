// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorReducer } from "@/features/portal/editor/editor-reducer";
import type { EditorState } from "@/features/portal/editor/editor-types";
import type { PortalElement, PortalSceneV1 } from "@/features/portal/portal-scene";

type FakeKonvaNode = {
  kind: string;
  attrs: Record<string, unknown>;
  listeners: Record<string, unknown>;
  applyProps: (props: Record<string, unknown>) => void;
  getPointerPosition: () => { x: number; y: number } | null;
  getStage: () => FakeKonvaNode;
  x: (value?: number) => number;
  y: (value?: number) => number;
  scaleX: (value?: number) => number;
  scaleY: (value?: number) => number;
  rotation: (value?: number) => number;
  nodes: (value?: FakeKonvaNode[]) => FakeKonvaNode[];
  getLayer: () => { batchDraw: () => undefined };
};

const konvaHarness = vi.hoisted(() => ({
  pointer: { x: 0, y: 0 } as { x: number; y: number } | null,
  stages: [] as FakeKonvaNode[],
  rendered: [] as Array<{ kind: string; props: Record<string, unknown> }>,
}));

vi.mock("react-konva", async () => {
  const React = await import("react");

  function nodeFor(kind: string, props: Record<string, unknown>): FakeKonvaNode {
    const attrs: Record<string, unknown> = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    };
    const node: FakeKonvaNode = {
      kind,
      attrs,
      listeners: {},
      applyProps(nextProps) {
        for (const [key, value] of Object.entries(nextProps)) {
          if (key === "children") continue;
          if (/^on[A-Z]/u.test(key)) {
            if (value === undefined) delete node.listeners[key];
            else node.listeners[key] = value;
          } else {
            attrs[key] = value;
          }
        }
      },
      getPointerPosition() {
        return konvaHarness.pointer;
      },
      getStage() {
        return node.kind === "Stage" ? node : (konvaHarness.stages[0] ?? node);
      },
      x(value?: number) {
        if (value !== undefined) attrs.x = value;
        return Number(attrs.x ?? 0);
      },
      y(value?: number) {
        if (value !== undefined) attrs.y = value;
        return Number(attrs.y ?? 0);
      },
      scaleX(value?: number) {
        if (value !== undefined) attrs.scaleX = value;
        return Number(attrs.scaleX ?? 1);
      },
      scaleY(value?: number) {
        if (value !== undefined) attrs.scaleY = value;
        return Number(attrs.scaleY ?? 1);
      },
      rotation(value?: number) {
        if (value !== undefined) attrs.rotation = value;
        return Number(attrs.rotation ?? 0);
      },
      nodes(value?: FakeKonvaNode[]) {
        if (value) attrs.attached = value;
        return (attrs.attached as FakeKonvaNode[] | undefined) ?? [];
      },
      getLayer: () => ({ batchDraw: () => undefined }),
    };
    node.applyProps(props);
    if (kind === "Stage") konvaHarness.stages.push(node);
    return node;
  }

  function component(kind: string) {
    return React.forwardRef(function Mock(props: Record<string, unknown>, ref) {
      const [node] = React.useState(() => nodeFor(kind, props));
      node.applyProps(props);
      React.useImperativeHandle(ref, () => node, [node]);
      konvaHarness.rendered.push({ kind, props });
      return React.createElement(
        kind === "Stage" ? "div" : "span",
        {
          "data-konva-kind": kind,
          "data-konva-name": typeof props.name === "string" ? props.name : undefined,
        },
        props.children as React.ReactNode,
      );
    });
  }

  return {
    Stage: component("Stage"),
    Layer: component("Layer"),
    Line: component("Line"),
    Rect: component("Rect"),
    Group: component("Group"),
    Transformer: component("Transformer"),
    Text: component("Text"),
    Circle: component("Circle"),
    Ellipse: component("Ellipse"),
    Arrow: component("Arrow"),
    Image: component("Image"),
    Path: component("Path"),
  };
});

vi.mock("lucide-react/dynamicIconImports", () => ({
  default: {},
}));

import { EditorStage } from "@/features/portal/editor/editor-stage";

function emptyScene(): PortalSceneV1 {
  return {
    sceneVersion: 1,
    viewport: "DESKTOP",
    requiresMobileReview: false,
    background: {
      assetId: null,
      fitMode: "COVER",
      positionX: 50,
      positionY: 50,
      backgroundColor: "#FFFFFF",
      locked: false,
    },
    elements: [],
  };
}

function editorState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    past: [],
    present: emptyScene(),
    future: [],
    selection: [],
    dirty: false,
    editVersion: 0,
    revision: 0,
    city: "SHANGHAI",
    viewport: "DESKTOP",
    zoom: 1,
    snapEnabled: true,
    transientPreview: null,
    clipboard: null,
    ...overrides,
  };
}

function Harness({
  drawTool = "FREEHAND",
  onFreehandComplete,
}: {
  drawTool?: "FREEHAND" | null;
  onFreehandComplete?(): void;
}) {
  const [state, dispatch] = useReducer(editorReducer, editorState());
  return (
    <div>
      <EditorStage
        state={state}
        dispatch={dispatch}
        drawTool={drawTool}
        onFreehandComplete={onFreehandComplete}
      />
      <output data-testid="element-count">{state.present.elements.length}</output>
      <output data-testid="selected">{state.selection.join(",")}</output>
      <output data-testid="types">
        {state.present.elements.map((element) => element.type).join(",")}
      </output>
    </div>
  );
}

function stageListeners() {
  const stage = konvaHarness.stages.at(-1);
  if (!stage) throw new Error("stage missing");
  return stage.listeners as Record<string, (event: { target: FakeKonvaNode; evt?: Event }) => void>;
}

function pointerAt(x: number, y: number) {
  konvaHarness.pointer = { x, y };
}

describe("EditorStage freehand drawing", () => {
  afterEach(() => {
    cleanup();
    konvaHarness.stages.length = 0;
    konvaHarness.rendered.length = 0;
    konvaHarness.pointer = { x: 0, y: 0 };
  });

  beforeEach(() => {
    konvaHarness.stages.length = 0;
    konvaHarness.rendered.length = 0;
  });

  it("draws a FREEHAND vector on pointer press/drag/release and selects it", () => {
    const onFreehandComplete = vi.fn();
    render(<Harness drawTool="FREEHAND" onFreehandComplete={onFreehandComplete} />);
    const listeners = stageListeners();
    const stage = konvaHarness.stages.at(-1)!;

    act(() => {
      pointerAt(100, 120);
      listeners.onMouseDown?.({ target: stage });
      pointerAt(140, 150);
      listeners.onMouseMove?.({ target: stage });
      pointerAt(180, 130);
      listeners.onMouseMove?.({ target: stage });
      listeners.onMouseUp?.({ target: stage });
    });

    expect(screen.getByTestId("element-count").textContent).toBe("1");
    expect(screen.getByTestId("types").textContent).toBe("FREEHAND");
    expect(screen.getByTestId("selected").textContent.length).toBeGreaterThan(0);
    expect(onFreehandComplete).toHaveBeenCalledOnce();
  });

  it("supports touch stroke completion for freehand", () => {
    render(<Harness drawTool="FREEHAND" />);
    const listeners = stageListeners();
    const stage = konvaHarness.stages.at(-1)!;

    act(() => {
      pointerAt(40, 50);
      listeners.onTouchStart?.({ target: stage });
      pointerAt(90, 100);
      listeners.onTouchMove?.({ target: stage });
      listeners.onTouchEnd?.({ target: stage });
    });

    expect(screen.getByTestId("types").textContent).toBe("FREEHAND");
  });

  it("does not create freehand strokes when draw tool is idle", () => {
    render(<Harness drawTool={null} />);
    const listeners = stageListeners();
    const stage = konvaHarness.stages.at(-1)!;

    act(() => {
      pointerAt(10, 10);
      listeners.onMouseDown?.({ target: stage });
      pointerAt(80, 80);
      listeners.onMouseMove?.({ target: stage });
      listeners.onMouseUp?.({ target: stage });
    });

    expect(screen.getByTestId("element-count").textContent).toBe("0");
  });

  it("renders committed FREEHAND with tension and round stroke style", () => {
    const freehand: Extract<PortalElement, { type: "FREEHAND" }> = {
      id: "fh-1",
      name: "自由绘制",
      type: "FREEHAND",
      x: 20,
      y: 30,
      width: 100,
      height: 60,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      hidden: false,
      points: [0, 0, 50, 40, 100, 10],
      stroke: "#1E88E5",
      strokeWidth: 4,
      tension: 0.4,
      lineCap: "ROUND",
      lineJoin: "ROUND",
    };
    render(
      <EditorStage
        state={editorState({
          present: { ...emptyScene(), elements: [freehand] },
          selection: ["fh-1"],
        })}
        dispatch={() => undefined}
      />,
    );

    const line = konvaHarness.rendered.findLast(
      (entry) => entry.kind === "Line" && entry.props.name === "portal-shape-fh-1",
    );
    expect(line).toMatchObject({
      kind: "Line",
      props: {
        points: [0, 0, 50, 40, 100, 10],
        stroke: "#1E88E5",
        strokeWidth: 4,
        tension: 0.4,
        lineCap: "round",
        lineJoin: "round",
      },
    });
    expect(screen.getByLabelText("自由绘制：自由绘制")).toBeTruthy();
    expect(screen.getByLabelText("选中元素控制框").getAttribute("data-resize-anchors"))
      .toContain("top-left");
    expect(screen.getByLabelText("选中元素控制框").getAttribute("data-rotation-enabled"))
      .toBe("true");
  });
});
