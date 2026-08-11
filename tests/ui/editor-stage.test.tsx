// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorReducer } from "@/features/portal/editor/editor-reducer";
import type { EditorAction, EditorState } from "@/features/portal/editor/editor-types";
import { elementBounds } from "@/features/portal/portal-geometry";
import {
  portalSceneV1Schema,
  type PortalElement,
  type PortalSceneV1,
} from "@/features/portal/portal-scene";

type FakeKonvaNode = {
  kind: string;
  attrs: Record<string, unknown>;
  attachedNodes: FakeKonvaNode[];
  children: Set<FakeKonvaNode>;
  destroyed: boolean;
  listeners: Record<string, unknown>;
  parent: FakeKonvaNode | null;
  applyProps: (props: Record<string, unknown>) => void;
  destroy: () => void;
  draggable: (value?: boolean) => boolean;
  getAbsoluteScale: () => { x: number; y: number };
  getClientRect: (options?: { skipTransform?: boolean }) => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  x: (value?: number) => number;
  y: (value?: number) => number;
  width: (value?: number) => number;
  height: (value?: number) => number;
  offsetX: (value?: number) => number;
  offsetY: (value?: number) => number;
  opacity: (value?: number) => number;
  visible: (value?: boolean) => boolean;
  scaleX: (value?: number) => number;
  scaleY: (value?: number) => number;
  rotation: (value?: number) => number;
  nodes: (value?: FakeKonvaNode[]) => FakeKonvaNode[];
};

const konvaHarness = vi.hoisted(() => ({
  rendered: [] as Array<{ kind: string; props: Record<string, unknown> }>,
  groups: new Map<string, {
    node: FakeKonvaNode;
    props: Record<string, unknown>;
  }>(),
  transformers: new Map<string, {
    node: FakeKonvaNode;
    props: Record<string, unknown>;
  }>(),
}));

const lucideHarness = vi.hoisted(() => ({
  mapPinLoader: vi.fn(async () => ({
    __iconNode: [
      ["path", { d: "M20 10c0 5-5 10-8 12C9 20 4 15 4 10a8 8 0 0 1 16 0", key: "pin" }],
      ["circle", { cx: "12", cy: "10", r: "3", key: "dot" }],
    ],
  })),
}));

vi.mock("lucide-react/dynamicIconImports", () => ({
  default: {
    "map-pin": lucideHarness.mapPinLoader,
  },
}));

vi.mock("react-konva", async () => {
  const React = await import("react");
  type Box = { x: number; y: number; width: number; height: number };
  const ParentNode = React.createContext<FakeKonvaNode | null>(null);

  const unionBoxes = (boxes: Box[]): Box => {
    if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const transformBox = (box: Box, attrs: Record<string, unknown>): Box => {
    const scaleX = Number(attrs.scaleX ?? 1);
    const scaleY = Number(attrs.scaleY ?? 1);
    const offsetX = Number(attrs.offsetX ?? 0);
    const offsetY = Number(attrs.offsetY ?? 0);
    const x = Number(attrs.x ?? 0);
    const y = Number(attrs.y ?? 0);
    const radians = Number(attrs.rotation ?? 0) * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x + box.width, box.y + box.height],
      [box.x, box.y + box.height],
    ].map(([pointX, pointY]) => {
      const localX = (pointX! - offsetX) * scaleX;
      const localY = (pointY! - offsetY) * scaleY;
      return {
        x: x + localX * cos - localY * sin,
        y: y + localX * sin + localY * cos,
      };
    });
    const left = Math.min(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const right = Math.max(...corners.map((point) => point.x));
    const bottom = Math.max(...corners.map((point) => point.y));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  function nodeFor(kind: string, props: Record<string, unknown>) {
    const declaredProps: Record<string, unknown> = {};
    const attrs: Record<string, unknown> = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      offsetX: 0,
      offsetY: 0,
      opacity: 1,
      visible: true,
      draggable: false,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    };
    const node: FakeKonvaNode & {
      getLayer: () => { batchDraw: () => undefined };
      container: () => HTMLElement;
    } = {
      kind,
      attrs,
      attachedNodes: [],
      children: new Set(),
      destroyed: false,
      listeners: {},
      parent: null,
      applyProps(nextProps) {
        for (const key of Object.keys(declaredProps)) {
          if (key === "children" || key in nextProps) continue;
          if (/^on[A-Z]/u.test(key)) delete node.listeners[key];
          else delete attrs[key];
          delete declaredProps[key];
        }
        for (const [key, value] of Object.entries(nextProps)) {
          if (key === "children" || declaredProps[key] === value) continue;
          if (/^on[A-Z]/u.test(key)) {
            if (value === undefined) delete node.listeners[key];
            else node.listeners[key] = value;
          } else {
            attrs[key] = value;
          }
          declaredProps[key] = value;
        }
      },
      destroy() {
        node.destroyed = true;
        node.parent?.children.delete(node);
        node.parent = null;
      },
      draggable(value?: boolean) {
        if (value !== undefined) attrs.draggable = value;
        return Boolean(attrs.draggable);
      },
      getAbsoluteScale() {
        let scaleX = node.scaleX();
        let scaleY = node.scaleY();
        let parent = node.parent;
        while (parent) {
          scaleX *= parent.scaleX();
          scaleY *= parent.scaleY();
          parent = parent.parent;
        }
        return { x: scaleX, y: scaleY };
      },
      getClientRect(options) {
        const intrinsicBox = (): Box => {
          if (node.kind === "Group" || node.kind === "Layer" || node.kind === "Stage") {
            return unionBoxes([...node.children]
              .filter((child) => child.visible())
              .map((child) => transformBox(child.getClientRect({ skipTransform: true }), child.attrs)));
          }
          if (node.kind === "Ellipse") {
            const radiusX = Number(attrs.radiusX ?? 0);
            const radiusY = Number(attrs.radiusY ?? 0);
            return { x: -radiusX, y: -radiusY, width: radiusX * 2, height: radiusY * 2 };
          }
          if (node.kind === "Circle") {
            const radius = Number(attrs.radius ?? 0);
            return { x: -radius, y: -radius, width: radius * 2, height: radius * 2 };
          }
          if (node.kind === "Line" || node.kind === "Arrow") {
            const points = (attrs.points as number[] | undefined) ?? [];
            const xs = points.filter((_, index) => index % 2 === 0);
            const ys = points.filter((_, index) => index % 2 === 1);
            if (xs.length === 0 || ys.length === 0) {
              return { x: 0, y: 0, width: 0, height: 0 };
            }
            const left = Math.min(...xs);
            const top = Math.min(...ys);
            return {
              x: left,
              y: top,
              width: Math.max(...xs) - left,
              height: Math.max(...ys) - top,
            };
          }
          if (node.kind === "Path") {
            return { x: 4, y: 2, width: 16, height: 20 };
          }
          return {
            x: 0,
            y: 0,
            width: Number(attrs.width ?? 0),
            height: Number(attrs.height ?? 0),
          };
        };
        let box = intrinsicBox();
        if (options?.skipTransform) return box;
        let current: FakeKonvaNode | null = node;
        while (current) {
          box = transformBox(box, current.attrs);
          current = current.parent;
        }
        return box;
      },
      x(value?: number) {
        if (value !== undefined) attrs.x = value;
        return Number(attrs.x);
      },
      y(value?: number) {
        if (value !== undefined) attrs.y = value;
        return Number(attrs.y);
      },
      width(value?: number) {
        if (value !== undefined) attrs.width = value;
        return Number(attrs.width);
      },
      height(value?: number) {
        if (value !== undefined) attrs.height = value;
        return Number(attrs.height);
      },
      offsetX(value?: number) {
        if (value !== undefined) attrs.offsetX = value;
        return Number(attrs.offsetX);
      },
      offsetY(value?: number) {
        if (value !== undefined) attrs.offsetY = value;
        return Number(attrs.offsetY);
      },
      opacity(value?: number) {
        if (value !== undefined) attrs.opacity = value;
        return Number(attrs.opacity);
      },
      visible(value?: boolean) {
        if (value !== undefined) attrs.visible = value;
        return attrs.visible !== false;
      },
      scaleX(value?: number) {
        if (value !== undefined) attrs.scaleX = value;
        return Number(attrs.scaleX);
      },
      scaleY(value?: number) {
        if (value !== undefined) attrs.scaleY = value;
        return Number(attrs.scaleY);
      },
      rotation(value?: number) {
        if (value !== undefined) attrs.rotation = value;
        return Number(attrs.rotation);
      },
      nodes(value?: FakeKonvaNode[]) {
        if (value) node.attachedNodes = value;
        return node.attachedNodes;
      },
      getLayer: () => ({ batchDraw: () => undefined }),
      container: () => document.body,
    };
    node.applyProps(props);
    return node;
  }

  function component(kind: string) {
    return React.forwardRef<ReturnType<typeof nodeFor>, Record<string, unknown>>(function MockKonvaComponent(
      props,
      ref,
    ) {
      const parent = React.useContext(ParentNode);
      const [node] = React.useState(() => nodeFor(kind, props));
      node.applyProps(props);
      React.useImperativeHandle(ref, () => node, [node]);
      React.useLayoutEffect(() => {
        node.parent = parent;
        parent?.children.add(node);
        return () => node.destroy();
      }, [node, parent]);
      if (kind === "Group" && typeof props.name === "string") {
        konvaHarness.groups.set(props.name, { node, props });
      }
      if (kind === "Transformer" && typeof props.name === "string") {
        konvaHarness.transformers.set(props.name, { node, props });
      }
      konvaHarness.rendered.push({ kind, props });
      return React.createElement(
        ParentNode.Provider,
        { value: node },
        React.createElement(
          kind === "Stage" ? "div" : "span",
          {
            "data-konva-kind": kind,
            "data-konva-name": typeof props.name === "string" ? props.name : undefined,
          },
          props.children as React.ReactNode,
        ),
      );
    });
  }

  return {
    Arrow: component("Arrow"),
    Circle: component("Circle"),
    Ellipse: component("Ellipse"),
    Group: component("Group"),
    Image: component("Image"),
    Layer: component("Layer"),
    Line: component("Line"),
    Path: component("Path"),
    Rect: component("Rect"),
    RegularPolygon: component("RegularPolygon"),
    Stage: component("Stage"),
    Text: component("Text"),
    Transformer: component("Transformer"),
  };
});

import {
  EditorStage,
  normalizeTransformedElement,
  snapElementPosition,
} from "@/features/portal/editor/editor-stage";
import { normalizeNodeTransform } from "@/features/portal/editor/element-node";

const base = (id: string, name: string, zIndex: number) => ({
  id,
  name,
  x: 40 + zIndex * 90,
  y: 80,
  width: 64,
  height: 48,
  rotation: 0,
  opacity: 1,
  zIndex,
  locked: false,
  hidden: false,
});

const elements: PortalElement[] = [
  {
    ...base("text", "前台", 0),
    type: "TEXT",
    text: "前台",
    color: "#112233",
    fontFamily: "Noto Sans SC Variable",
    fontSize: 20,
    fontWeight: 400,
    lineHeight: 1.4,
    align: "LEFT",
    italic: true,
    underline: true,
    letterSpacing: 2,
    backgroundColor: "#FFF7ED",
    action: { href: "/front-desk", target: "_self" },
  },
  {
    ...base("rect", "矩形", 1),
    type: "RECT",
    fillEnabled: true,
    fill: "#FFFFFF",
    lastFillColor: "#FFFFFF",
    stroke: "#112233",
    strokeWidth: 2,
    dash: "DASHED",
    shadow: { color: "#000000", opacity: 0.3, blur: 9, offsetX: 3, offsetY: 4 },
  },
  { ...base("circle", "圆形", 2), type: "CIRCLE", fillEnabled: true, fill: "#FFFFFF", lastFillColor: "#FFFFFF", stroke: null, strokeWidth: 0, dash: "SOLID", shadow: null },
  { ...base("ellipse", "椭圆", 3), type: "ELLIPSE", fillEnabled: true, fill: "#FFFFFF", lastFillColor: "#FFFFFF", stroke: null, strokeWidth: 0, dash: "SOLID", shadow: null },
  { ...base("round-rect", "圆角矩形", 4), type: "ROUND_RECT", fillEnabled: true, fill: "#FFFFFF", lastFillColor: "#FFFFFF", stroke: null, strokeWidth: 0, cornerRadius: 12, dash: "SOLID", shadow: null },
  { ...base("triangle", "三角形", 5), type: "TRIANGLE", fillEnabled: true, fill: "#FFFFFF", lastFillColor: "#FFFFFF", stroke: null, strokeWidth: 0, dash: "SOLID", shadow: null },
  { ...base("line", "线条", 6), type: "LINE", stroke: "#112233", strokeWidth: 2, dash: "DOTTED", shadow: null },
  { ...base("arrow", "箭头", 7), type: "ARROW", stroke: "#112233", strokeWidth: 2, pointerLength: 10, pointerWidth: 8, dash: "SOLID", shadow: null },
  {
    ...base("image", "办公环境", 8),
    type: "IMAGE",
    assetId: "asset-image",
    altText: "办公环境",
    fitMode: "COVER",
    crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
    cornerRadius: 10,
    action: { href: "/office", target: "_self" },
  },
  { ...base("icon", "位置图标", 9), type: "ICON", iconName: "MapPin", color: "#112233", action: null },
  {
    ...base("button", "查看指南", 10),
    type: "BUTTON",
    text: "查看指南",
    backgroundColor: "#112233",
    cornerRadius: 8,
    action: { href: "/guides", target: "_self" },
    color: "#FFFFFF",
    fontFamily: "Noto Sans SC Variable",
    fontSize: 18,
    fontWeight: 600,
    lineHeight: 1.2,
    align: "CENTER",
    border: { color: "#FFFFFF", width: 3, dash: "DOTTED" },
    shadow: { color: "#000000", opacity: 0.4, blur: 12, offsetX: 0, offsetY: 5 },
  },
  {
    ...base("marker", "位置标记", 11),
    type: "MARKER",
    text: "A",
    color: "#FFFFFF",
    backgroundColor: "#112233",
    iconName: "MapPin",
    title: "前台",
    description: "访客请在这里登记",
  },
];

function scene(sceneElements = elements): PortalSceneV1 {
  return {
    sceneVersion: 1,
    viewport: "DESKTOP",
    requiresMobileReview: false,
    background: {
      assetId: "background-asset",
      fitMode: "COVER",
      positionX: 50,
      positionY: 50,
      backgroundColor: "#F5F5F5",
      locked: false,
    },
    elements: sceneElements,
  };
}

function state(present = scene(), overrides: Partial<EditorState> = {}): EditorState {
  return {
    past: [],
    present,
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

describe("EditorStage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    konvaHarness.rendered.length = 0;
    konvaHarness.groups.clear();
    konvaHarness.transformers.clear();
    lucideHarness.mapPinLoader.mockClear();
  });

  it("renders all twelve strict element types above a separate background layer", () => {
    render(<EditorStage state={state()} dispatch={() => undefined} />);

    expect(screen.getByLabelText("门户画布")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /：/u })).toHaveLength(12);
    expect([...document.querySelectorAll("[data-portal-element-type]")].map((node) =>
      node.getAttribute("data-portal-element-type"))).toEqual([
      "TEXT",
      "RECT",
      "CIRCLE",
      "ELLIPSE",
      "ROUND_RECT",
      "TRIANGLE",
      "LINE",
      "ARROW",
      "IMAGE",
      "ICON",
      "BUTTON",
      "MARKER",
    ]);

    const layers = [...document.querySelectorAll("[data-konva-kind='Layer']")];
    expect(layers[0]?.getAttribute("data-konva-name")).toBe("portal-background-layer");
    expect(layers[1]?.getAttribute("data-konva-name")).toBe("portal-elements-layer");
  });

  it("renders every strict branch with canonical geometry from trusted public icon nodes", async () => {
    render(<EditorStage state={state()} dispatch={() => undefined} />);

    expect(konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-rect",
    )).toMatchObject({
      kind: "Rect",
      props: {
        width: 64,
        height: 48,
        fillEnabled: true,
        fill: "#FFFFFF",
        stroke: "#112233",
        strokeWidth: 2,
        dash: [8, 6],
        shadowColor: "#000000",
        shadowOpacity: 0.3,
        shadowBlur: 9,
        shadowOffsetX: 3,
        shadowOffsetY: 4,
      },
    });

    const circle = konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-circle",
    );
    expect(circle).toMatchObject({
      kind: "Ellipse",
      props: { radiusX: 32, radiusY: 24 },
    });

    expect(konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-ellipse",
    )).toMatchObject({
      kind: "Ellipse",
      props: { x: 32, y: 24, radiusX: 32, radiusY: 24 },
    });

    expect(konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-round-rect",
    )).toMatchObject({
      kind: "Rect",
      props: { width: 64, height: 48, cornerRadius: 12 },
    });

    const triangle = konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-triangle",
    );
    expect(triangle).toMatchObject({
      kind: "Line",
      props: {
        points: [32, 0, 64, 48, 0, 48],
        closed: true,
        lineJoin: "round",
      },
    });

    expect(konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-line",
    )).toMatchObject({
      kind: "Line",
      props: {
        points: [0, 0, 64, 48],
        stroke: "#112233",
        strokeWidth: 2,
        dash: [2, 4],
        lineCap: "round",
        lineJoin: "round",
      },
    });

    const arrow = konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-shape-arrow",
    );
    expect(arrow).toMatchObject({
      kind: "Arrow",
      props: { points: [0, 0, 64, 48], pointerLength: 10, pointerWidth: 8 },
    });

    expect(konvaHarness.rendered.some(
      ({ kind, props }) => kind === "Text" && props.text === "MapPin",
    )).toBe(false);
    await waitFor(() => expect(lucideHarness.mapPinLoader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(konvaHarness.rendered.some(
      ({ kind, props }) =>
        (kind === "Path" || kind === "Circle") && String(props.name).startsWith("portal-icon-icon-"),
    )).toBe(true));

    const iconBounds = konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-icon-bounds-icon",
    );
    expect(iconBounds).toMatchObject({
      kind: "Rect",
      props: {
        x: 0,
        y: 0,
        width: 64,
        height: 48,
        listening: false,
      },
    });
    expect(konvaHarness.groups.get("portal-element-icon")?.node.getClientRect({
      skipTransform: true,
    })).toEqual({ x: 0, y: 0, width: 64, height: 48 });

    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Rect"
        && props.name === "portal-shape-button",
    )).toMatchObject({
      kind: "Rect",
      props: { width: 64, height: 48, fill: "#112233", cornerRadius: 8 },
    });
    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Text" && props.text === "查看指南",
    )?.props).toMatchObject({
      width: 64,
      height: 48,
      fill: "#FFFFFF",
      align: "center",
      verticalAlign: "middle",
    });

    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Rect"
        && props.name === "portal-shape-button",
    )?.props).toMatchObject({
      stroke: "#FFFFFF",
      strokeWidth: 3,
      dash: [3, 6],
      shadowColor: "#000000",
      shadowBlur: 12,
      shadowOffsetY: 5,
    });

    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Ellipse"
        && props.name === "portal-shape-marker",
    )?.props).toMatchObject({
      x: 32,
      y: 24,
      radiusX: 32,
      radiusY: 24,
      fill: "#112233",
    });
    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Text" && props.text === "A",
    )?.props).toMatchObject({
      x: 29.92,
      width: 30.08,
      height: 48,
      fill: "#FFFFFF",
      align: "center",
      verticalAlign: "middle",
    });
  });

  it("loads images with anonymous CORS, aspect-preserving cover crop, and releases superseded loads", () => {
    class ControlledImage {
      static instances: ControlledImage[] = [];
      events: string[] = [];
      naturalWidth = 400;
      naturalHeight = 200;
      decoding = "";
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;
      private source = "";
      private cors: string | null = null;

      constructor() {
        ControlledImage.instances.push(this);
      }

      set crossOrigin(value: string | null) {
        this.cors = value;
        this.events.push(`cors:${value}`);
      }

      get crossOrigin() {
        return this.cors;
      }

      set src(value: string) {
        this.source = value;
        this.events.push(`src:${value}`);
      }

      get src() {
        return this.source;
      }
    }

    vi.stubGlobal("Image", ControlledImage);
    const image = {
      ...elements.find((element): element is Extract<PortalElement, { type: "IMAGE" }> =>
        element.type === "IMAGE")!,
      x: 40,
      zIndex: 0,
    };
    const imageScene = scene([image]);
    imageScene.background.assetId = null;
    const { rerender } = render(
      <EditorStage
        state={state(imageScene)}
        dispatch={() => undefined}
        assetUrlForId={(assetId) => `https://cdn.example/${assetId}`}
      />,
    );

    const first = ControlledImage.instances[0]!;
    expect(first.events.slice(0, 2)).toEqual([
      "cors:anonymous",
      "src:https://cdn.example/asset-image",
    ]);
    act(() => first.onload?.(new Event("load")));

    const renderedImage = konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Image" && props.image === first,
    );
    expect(renderedImage?.props).toMatchObject({
      width: 64,
      height: 48,
      crop: { x: 100, y: 40, width: 160, height: 120 },
    });
    expect(konvaHarness.groups.get("portal-image-clip-image")?.props.clipFunc).toEqual(
      expect.any(Function),
    );

    const replacement = { ...image, assetId: "asset-replacement" };
    const replacementScene = scene([replacement]);
    replacementScene.background.assetId = null;
    rerender(
      <EditorStage
        state={state(replacementScene)}
        dispatch={() => undefined}
        assetUrlForId={(assetId) => `https://cdn.example/${assetId}`}
      />,
    );
    const second = ControlledImage.instances.at(-1)!;
    expect(first.src).toBe("");
    expect(first.onload).toBeNull();
    expect(first.onerror).toBeNull();
    expect(second.events.slice(0, 2)).toEqual([
      "cors:anonymous",
      "src:https://cdn.example/asset-replacement",
    ]);
    expect(typeof second.onerror).toBe("function");

    act(() => second.onerror?.(new Event("error")));
    expect(document.querySelector("[data-konva-kind='Image']")).toBeNull();
  });

  it("preserves the source aspect ratio when an image element uses contain", () => {
    class ContainImage {
      static instances: ContainImage[] = [];
      naturalWidth = 400;
      naturalHeight = 200;
      decoding = "";
      crossOrigin: string | null = null;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;
      src = "";

      constructor() {
        ContainImage.instances.push(this);
      }
    }

    vi.stubGlobal("Image", ContainImage);
    const image = {
      ...elements.find((element): element is Extract<PortalElement, { type: "IMAGE" }> =>
        element.type === "IMAGE")!,
      fitMode: "CONTAIN" as const,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zIndex: 0,
    };
    const imageScene = scene([image]);
    imageScene.background.assetId = null;

    render(
      <EditorStage
        state={state(imageScene)}
        dispatch={() => undefined}
        assetUrlForId={(assetId) => `https://cdn.example/${assetId}`}
      />,
    );
    const loaded = ContainImage.instances[0]!;
    act(() => loaded.onload?.(new Event("load")));

    expect(konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Image" && props.image === loaded,
    )?.props).toMatchObject({
      x: 0,
      y: 8,
      width: 64,
      height: 32,
      crop: { x: 0, y: 0, width: 400, height: 200 },
    });
  });

  it("runs image cropping as transient previews and applies one committed undo step", async () => {
    class CropImage {
      static instances: CropImage[] = [];
      naturalWidth = 400;
      naturalHeight = 200;
      decoding = "";
      crossOrigin: string | null = null;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;
      src = "";

      constructor() {
        CropImage.instances.push(this);
      }
    }

    vi.stubGlobal("Image", CropImage);
    const image = {
      ...elements.find((element): element is Extract<PortalElement, { type: "IMAGE" }> =>
        element.type === "IMAGE")!,
      zIndex: 0,
    };
    const other = {
      ...elements.find((element) => element.type === "RECT")!,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      zIndex: 1,
    };
    const imageScene = scene([image, other]);
    imageScene.background.assetId = null;
    const actions: EditorAction[] = [];
    const onCropExit = vi.fn();
    render(
      <EditorStage
        state={state(imageScene, { selection: ["image"] })}
        dispatch={(action) => actions.push(action)}
        cropTargetId="image"
        onCropExit={onCropExit}
      />,
    );

    act(() => {
      for (const instance of CropImage.instances) instance.onload?.(new Event("load"));
    });
    expect(konvaHarness.groups.get("portal-element-image")?.props.listening).toBe(true);
    expect(konvaHarness.groups.get("portal-element-rect")?.props.listening).toBe(false);
    expect(konvaHarness.groups.get("portal-element-rect")?.props.draggable).toBe(false);
    expect(konvaHarness.groups.get("portal-element-rect")?.props.onDragMove).toBeUndefined();

    expect(await screen.findByRole("toolbar", { name: "图片裁剪工具" })).not.toBeNull();
    const keyboard = screen.getByLabelText("图片裁剪键盘控制");
    expect(keyboard.textContent).toContain("方向键");
    expect(document.activeElement).toBe(keyboard);
    expect(konvaHarness.groups.get("portal-element-image")?.props.draggable).toBe(false);
    expect(konvaHarness.transformers.has("portal-selection-transformer")).toBe(false);
    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "裁剪放大" }));
    fireEvent.click(screen.getByRole("button", { name: "裁剪放大" }));
    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT")).toHaveLength(3);
    expect(actions.filter((action) => action.type === "COMMIT_ELEMENT")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "应用裁剪" }));
    expect(actions.filter((action) => action.type === "COMMIT_ELEMENT")).toHaveLength(1);
    expect(actions.at(-1)).toEqual({ type: "CLEAR_PREVIEW" });
    expect(onCropExit).toHaveBeenCalledTimes(1);
  });

  it("supports local drag, wheel and crop keyboard controls without leaking Delete", () => {
    class CropImage {
      static instances: CropImage[] = [];
      naturalWidth = 400;
      naturalHeight = 200;
      decoding = "";
      crossOrigin: string | null = null;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;
      src = "";

      constructor() {
        CropImage.instances.push(this);
      }
    }

    vi.stubGlobal("Image", CropImage);
    const image = {
      ...elements.find((element): element is Extract<PortalElement, { type: "IMAGE" }> =>
        element.type === "IMAGE")!,
      zIndex: 0,
    };
    const imageScene = scene([image]);
    imageScene.background.assetId = null;
    const actions: EditorAction[] = [];
    render(
      <EditorStage
        state={state(imageScene, { selection: ["image"], zoom: 0.4 })}
        dispatch={(action) => actions.push(action)}
        cropTargetId="image"
        onCropExit={() => undefined}
      />,
    );
    act(() => {
      for (const instance of CropImage.instances) instance.onload?.(new Event("load"));
    });

    const overlay = konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-image-crop-overlay-image",
    )!;
    const overlayNode = konvaHarness.groups.get("portal-element-image")!.node;
    const cropRect = [...overlayNode.children].find(
      (node) => node.attrs.name === "portal-image-crop-overlay-image",
    )!;
    cropRect.x(8);
    cropRect.y(-4);
    act(() => {
      (overlay.props.onDragMove as (event: { target: FakeKonvaNode }) => void)({
        target: cropRect,
      });
    });
    cropRect.x(12);
    cropRect.y(-6);
    act(() => {
      (overlay.props.onDragMove as (event: { target: FakeKonvaNode }) => void)({
        target: cropRect,
      });
    });
    const secondPan = actions.filter(
      (action): action is Extract<EditorAction, { type: "PREVIEW_ELEMENT" }> =>
        action.type === "PREVIEW_ELEMENT",
    ).at(-1);
    expect((secondPan?.patch as { crop?: { x: number; y: number } }).crop?.x)
      .toBeCloseTo(0.175);
    expect((secondPan?.patch as { crop?: { x: number; y: number } }).crop?.y)
      .toBeCloseTo(0.275);
    const previewsBeforeBrowserZoom = actions.filter(
      (action) => action.type === "PREVIEW_ELEMENT",
    ).length;
    const browserZoomPreventDefault = vi.fn();
    act(() => {
      (overlay.props.onWheel as (event: { evt: WheelEvent }) => void)({
        evt: {
          deltaY: -100,
          ctrlKey: true,
          metaKey: false,
          preventDefault: browserZoomPreventDefault,
        } as unknown as WheelEvent,
      });
    });
    expect(browserZoomPreventDefault).not.toHaveBeenCalled();
    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT"))
      .toHaveLength(previewsBeforeBrowserZoom);
    const macBrowserZoomPreventDefault = vi.fn();
    act(() => {
      (overlay.props.onWheel as (event: { evt: WheelEvent }) => void)({
        evt: {
          deltaY: -100,
          ctrlKey: false,
          metaKey: true,
          preventDefault: macBrowserZoomPreventDefault,
        } as unknown as WheelEvent,
      });
    });
    expect(macBrowserZoomPreventDefault).not.toHaveBeenCalled();
    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT"))
      .toHaveLength(previewsBeforeBrowserZoom);

    const cropWheelPreventDefault = vi.fn();
    act(() => {
      (overlay.props.onWheel as (event: { evt: WheelEvent }) => void)({
        evt: {
          deltaY: -100,
          ctrlKey: false,
          metaKey: false,
          preventDefault: cropWheelPreventDefault,
        } as unknown as WheelEvent,
      });
    });
    expect(cropWheelPreventDefault).toHaveBeenCalledTimes(1);

    const keyboard = screen.getByLabelText("图片裁剪键盘控制");
    fireEvent.keyDown(keyboard, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(keyboard, { key: "+" });
    fireEvent.keyDown(keyboard, { key: "Home" });
    const resetPreview = actions.filter(
      (action): action is Extract<EditorAction, { type: "PREVIEW_ELEMENT" }> =>
        action.type === "PREVIEW_ELEMENT",
    ).at(-1);
    const resetCrop = (resetPreview?.patch as {
      crop?: { x: number; y: number; width: number; height: number };
    }).crop;
    expect(resetCrop?.x).toBeCloseTo(1 / 6);
    expect(resetCrop?.y).toBe(0);
    expect(resetCrop?.width).toBeCloseTo(2 / 3);
    expect(resetCrop?.height).toBe(1);
    fireEvent.keyDown(keyboard, { key: "Delete" });
    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT").length)
      .toBeGreaterThanOrEqual(5);
    expect(actions.some((action) => action.type === "DELETE_ELEMENT")).toBe(false);
    expect(actions.some((action) => action.type === "SHORTCUT")).toBe(false);
  });

  it("shows a Chinese crop load failure and rejects locked image targets", async () => {
    class BrokenImage {
      static instances: BrokenImage[] = [];
      naturalWidth = 0;
      naturalHeight = 0;
      decoding = "";
      crossOrigin: string | null = null;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event | string) => void) | null = null;
      src = "";

      constructor() {
        BrokenImage.instances.push(this);
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    const image = {
      ...elements.find((element): element is Extract<PortalElement, { type: "IMAGE" }> =>
        element.type === "IMAGE")!,
      zIndex: 0,
    };
    const imageScene = scene([image]);
    imageScene.background.assetId = null;
    const { rerender } = render(
      <EditorStage
        state={state(imageScene, { selection: ["image"] })}
        dispatch={() => undefined}
        cropTargetId="image"
        onCropExit={() => undefined}
      />,
    );
    act(() => BrokenImage.instances.at(-1)?.onerror?.(new Event("error")));
    expect((await screen.findByRole("alert")).textContent).toContain("图片加载失败");
    expect(screen.queryByRole("toolbar", { name: "图片裁剪工具" })).toBeNull();

    const lockedScene = scene([{ ...image, locked: true }]);
    lockedScene.background.assetId = null;
    rerender(
      <EditorStage
        state={state(lockedScene, { selection: ["image"] })}
        dispatch={() => undefined}
        cropTargetId="image"
        onCropExit={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("锁定");
    expect(screen.queryByRole("toolbar", { name: "图片裁剪工具" })).toBeNull();

    const hiddenScene = scene([{ ...image, hidden: true }]);
    hiddenScene.background.assetId = null;
    rerender(
      <EditorStage
        state={state(hiddenScene, { selection: ["image"] })}
        dispatch={() => undefined}
        cropTargetId="image"
        onCropExit={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("隐藏");
    expect(screen.queryByRole("toolbar", { name: "图片裁剪工具" })).toBeNull();
  });

  it("paints page background via CSS plane matching published contain/cover model", () => {
    const coverScene = scene([]);
    coverScene.background = {
      ...coverScene.background,
      fitMode: "COVER",
      positionX: 25,
      positionY: 75,
    };
    const { rerender } = render(
      <EditorStage
        state={state(coverScene)}
        dispatch={() => undefined}
        assetUrlForId={(assetId) => `https://cdn.example/${assetId}`}
      />,
    );
    const plane = screen.getByTestId("portal-editor-background-plane");
    expect(plane.style.backgroundImage).toContain("https://cdn.example/background-asset");
    expect(plane.style.backgroundSize).toBe("cover");
    expect(plane.style.backgroundPosition).toBe("25% 75%");
    // Host is unclipped; canvas clip still hides stage overflow.
    expect(screen.getByTestId("portal-editor-stage-host").style.overflow).toBe("visible");
    expect(screen.getByTestId("portal-editor-canvas-clip").style.overflow).toBe("hidden");

    const containScene = scene([]);
    containScene.background = {
      ...containScene.background,
      fitMode: "CONTAIN",
      positionX: 25,
      positionY: 75,
    };
    rerender(
      <EditorStage
        state={state(containScene)}
        dispatch={() => undefined}
        assetUrlForId={(assetId) => `https://cdn.example/${assetId}`}
      />,
    );
    expect(screen.getByTestId("portal-editor-background-plane").style.backgroundSize).toBe("contain");
    expect(screen.getByTestId("portal-editor-background-plane").style.backgroundPosition).toBe("25% 75%");
  });

  it("expands the logical stage and anchors an auto-height background at the top", () => {
    const longScene = scene([]);
    longScene.background = {
      ...longScene.background,
      fitMode: "AUTO_HEIGHT",
      naturalWidth: 1_625,
      naturalHeight: 6_375,
    };
    const zoom = 0.5;
    render(<EditorStage state={state(longScene, { zoom })} dispatch={() => undefined} />);

    const logicalHeight = 1_440 * 6_375 / 1_625;
    expect(Number.parseFloat(screen.getByTestId("portal-editor-stage-host").style.height))
      .toBeCloseTo(logicalHeight * zoom, 8);
    expect(screen.getByTestId("portal-editor-background-plane").style.backgroundSize).toBe("100%");
    expect(screen.getByTestId("portal-editor-background-plane").style.backgroundPosition).toBe("left top");
    expect(konvaHarness.rendered.findLast(({ kind }) => kind === "Stage")?.props.height)
      .toBeCloseTo(logicalHeight * zoom, 8);
  });

  it("renders the 6-button adjustment overlay outside the clipped canvas host", () => {
    const rect = elements.find((element) => element.type === "RECT")!;
    const withSelection = state(scene([rect]), { selection: [rect.id], zoom: 0.1 });
    render(
      <EditorStage
        state={withSelection}
        dispatch={() => undefined}
      />,
    );
    const overlay = screen.getByTestId("portal-adjustment-overlay");
    const clip = screen.getByTestId("portal-editor-canvas-clip");
    expect(clip.contains(overlay)).toBe(false);
    expect(screen.getByTestId("portal-editor-stage-host").contains(overlay)).toBe(true);
    expect(within(overlay).getAllByRole("button")).toHaveLength(6);
  });

  it("passes the strict numeric font weight and enriched text styling to Konva", () => {
    render(<EditorStage state={state()} dispatch={() => undefined} />);

    const renderedText = konvaHarness.rendered.find(
      ({ kind, props }) => kind === "Text" && props.text === "前台",
    );
    expect(renderedText?.props).toMatchObject({
      fontStyle: "italic 400",
      textDecoration: "underline",
      letterSpacing: 2,
    });
    expect(konvaHarness.rendered.findLast(
      ({ props }) => props.name === "portal-text-background-text",
    )?.props).toMatchObject({
      width: 64,
      height: 48,
      fill: "#FFF7ED",
    });
  });

  it("selects and edits through the actual Konva Group handlers with exact anchors", () => {
    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, state());
      return <EditorStage state={editorState} dispatch={dispatch} />;
    }

    render(<Harness />);
    let group = konvaHarness.groups.get("portal-element-text")!;
    act(() => {
      (group.props.onClick as (event: { evt: { shiftKey: boolean } }) => void)({
        evt: { shiftKey: false },
      });
    });

    const transformer = konvaHarness.transformers.get("portal-selection-transformer")!;
    expect(transformer.props.enabledAnchors).toEqual([
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]);
    expect(transformer.props.rotateEnabled).toBe(true);
    expect(transformer.node.attachedNodes).toEqual([
      konvaHarness.groups.get("portal-element-text")?.node,
    ]);

    group = konvaHarness.groups.get("portal-element-text")!;
    act(() => {
      (group.props.onDblClick as () => void)();
    });
    const textarea = screen.getByRole("textbox", { name: "编辑文字" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("前台");
  });

  it("locks image aspect ratio by default while keeping all eight resize handles", () => {
    render(<EditorStage state={state(scene(), { selection: ["image"] })} dispatch={() => undefined} />);

    const transformer = konvaHarness.transformers.get("portal-selection-transformer")!;
    expect(transformer.props.keepRatio).toBe(true);
    expect(transformer.props.enabledAnchors).toHaveLength(8);
  });

  it.each([0.1, 4])(
    "keeps Stage scale exact at zoom %s and leaves the one-design-pixel minimum to normalization",
    (zoom) => {
      const selectedState = state(scene([elements[0]!]), {
        selection: ["text"],
        zoom,
      });
      render(<EditorStage state={selectedState} dispatch={() => undefined} />);

      const stageProps = konvaHarness.rendered.findLast(({ kind }) => kind === "Stage")?.props;
      expect(stageProps).toMatchObject({ scaleX: zoom, scaleY: zoom });
      expect(konvaHarness.groups.get("portal-element-text")?.node.getAbsoluteScale()).toEqual({
        x: zoom,
        y: zoom,
      });

      const transformer = konvaHarness.transformers.get("portal-selection-transformer")!;
      const oldBox = { x: 0, y: 0, width: 64 * zoom, height: 48 * zoom, rotation: 0 };
      const subMinimumBox = {
        ...oldBox,
        width: 0.5 * zoom,
        height: 0.5 * zoom,
      };
      const boundBox = transformer.props.boundBoxFunc as
        | ((oldValue: typeof oldBox, newValue: typeof oldBox) => typeof oldBox)
        | undefined;
      expect(boundBox ? boundBox(oldBox, subMinimumBox) : subMinimumBox).toEqual(subMinimumBox);
      expect(normalizeNodeTransform(elements[0]!, {
        x: 40,
        y: 40,
        scaleX: 0.5 / elements[0]!.width,
        scaleY: 0.5 / elements[0]!.height,
        rotation: 0,
      })).toMatchObject({ width: 1, height: 1 });
    },
  );

  it("aligns visible keyboard focus targets to the canvas and opens text editing with Enter", () => {
    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, state());
      return <EditorStage state={editorState} dispatch={dispatch} />;
    }

    render(<Harness />);
    const keyboardLayer = screen.getByLabelText("画布键盘操作层");
    expect(keyboardLayer.getAttribute("style")).not.toContain("width: 1px");

    const textTarget = screen.getByRole("button", { name: "文字：前台" });
    expect(textTarget.style.left).toBe("40px");
    expect(textTarget.style.top).toBe("80px");
    expect(textTarget.style.width).toBe("64px");
    expect(textTarget.style.height).toBe("48px");
    expect(textTarget.style.transform).toBe("rotate(0deg)");

    fireEvent.focus(textTarget);
    expect(textTarget.style.outline).toContain("solid");
    fireEvent.keyDown(textTarget, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "编辑文字" })).not.toBeNull();
  });

  it("offers visible focusable keyboard resize and rotation controls with canonical commits", async () => {
    const user = userEvent.setup();
    const actions: EditorAction[] = [];
    const rect = {
      ...elements.find((element): element is Extract<PortalElement, { type: "RECT" }> =>
        element.type === "RECT")!,
      x: 200,
      zIndex: 0,
    };
    let latestState = state(scene([rect]));

    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, latestState);
      latestState = editorState;
      return (
        <EditorStage
          state={editorState}
          dispatch={(action) => {
            actions.push(action);
            dispatch(action);
          }}
        />
      );
    }

    render(<Harness />);
    const group = konvaHarness.groups.get("portal-element-rect")!;
    act(() => {
      (group.props.onClick as (event: { evt: { shiftKey: boolean } }) => void)({
        evt: { shiftKey: false },
      });
    });

    const controls = screen.getByRole("group", { name: "选中元素精确调整" });
    expect(controls.style.display).toBe("flex");
    expect(controls.style.pointerEvents).toBe("auto");

    const growWidth = screen.getByRole("button", { name: "宽度增加 1 像素" });
    growWidth.focus();
    expect(growWidth.style.outline).toContain("solid");
    await user.keyboard("{Enter}");
    expect(latestState.present.elements[0]).toMatchObject({ width: 65, height: 48, rotation: 0 });

    const shrinkHeight = screen.getByRole("button", { name: "高度减少 1 像素" });
    shrinkHeight.focus();
    await user.keyboard(" ");
    expect(latestState.present.elements[0]).toMatchObject({ width: 65, height: 47, rotation: 0 });

    const rotateClockwise = screen.getByRole("button", { name: "顺时针旋转 1 度" });
    rotateClockwise.focus();
    await user.keyboard("{Enter}");
    expect(latestState.present.elements[0]).toMatchObject({ width: 65, height: 47, rotation: 1 });
    expect(portalSceneV1Schema.safeParse(latestState.present).success).toBe(true);
    expect(latestState.past).toHaveLength(3);
    expect(actions.filter((action) => action.type === "COMMIT_ELEMENT")).toHaveLength(3);
  });

  it("keeps locked nodes immobile and does not attach a transformer", () => {
    const lockedText = { ...elements[0]!, locked: true };
    const dispatch = vi.fn<(action: EditorAction) => void>();
    render(<EditorStage state={state(scene([lockedText]))} dispatch={dispatch} />);

    fireEvent.click(screen.getByRole("button", { name: "文字：前台" }));
    expect(screen.queryByLabelText("选中元素控制框")).toBeNull();
    expect(screen.queryByRole("group", { name: "选中元素精确调整" })).toBeNull();
    expect(konvaHarness.groups.get("portal-element-text")?.props.draggable).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "SELECT_ELEMENT", id: "text", source: "CANVAS" });
  });

  it("previews pointer motion without history and commits exactly once at pointer end", () => {
    const actions: EditorAction[] = [];
    const dispatch = (action: EditorAction) => actions.push(action);
    render(<EditorStage state={state()} dispatch={dispatch} />);

    const group = konvaHarness.groups.get("portal-element-text")!;
    group.node.x(200);
    group.node.y(160);
    act(() => {
      (group.props.onDragMove as (event: { target: typeof group.node }) => void)({ target: group.node });
      (group.props.onDragEnd as (event: { target: typeof group.node }) => void)({ target: group.node });
    });

    expect(actions.filter((action) => action.type === "PREVIEW_ELEMENT")).toHaveLength(1);
    expect(actions.filter((action) => action.type === "COMMIT_ELEMENT")).toHaveLength(1);
  });

  it("normalizes transform scale into dimensions before committing", () => {
    expect(normalizeNodeTransform(elements[0]!, {
      x: 240,
      y: 180,
      scaleX: 2,
      scaleY: 0.5,
      rotation: 30,
    })).toEqual({
      x: 176,
      y: 168,
      width: 128,
      height: 24,
      rotation: 30,
    });
  });

  it("uses one immutable transform baseline across repeated controlled previews and one undo entry", () => {
    const actions: EditorAction[] = [];
    let latestState = state(scene(), { selection: ["text"] });
    let reduce!: (action: EditorAction) => void;

    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, latestState);
      latestState = editorState;
      reduce = (action) => {
        actions.push(action);
        dispatch(action);
      };
      return <EditorStage state={editorState} dispatch={reduce} />;
    }

    render(<Harness />);
    let group = konvaHarness.groups.get("portal-element-text")!;
    expect(typeof group.props.onTransformStart).toBe("function");

    act(() => {
      (group.props.onTransformStart as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    group = konvaHarness.groups.get("portal-element-text")!;
    act(() => {
      group.node.x(240);
      group.node.y(180);
      group.node.scaleX(2);
      group.node.scaleY(0.5);
      group.node.rotation(30);
    });
    act(() => {
      group = konvaHarness.groups.get("portal-element-text")!;
      (group.props.onTransform as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    expect(group.node.scaleX()).toBe(2);
    expect(group.node.width()).toBe(64);

    act(() => {
      group = konvaHarness.groups.get("portal-element-text")!;
      (group.props.onTransform as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
      group = konvaHarness.groups.get("portal-element-text")!;
      (group.props.onTransformEnd as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });

    expect(latestState.present.elements[0]).toMatchObject({
      x: 176,
      y: 168,
      width: 128,
      height: 24,
      rotation: 30,
    });
    expect(latestState.past).toHaveLength(1);
    expect(latestState.transientPreview).toBeNull();
    expect(actions.filter((action) => action.type === "COMMIT_ELEMENT")).toHaveLength(1);
    expect(group.node.scaleX()).toBe(1);
    expect(group.node.scaleY()).toBe(1);

    act(() => reduce({ type: "UNDO" }));
    expect(latestState.present.elements[0]).toMatchObject({
      x: 40,
      y: 80,
      width: 64,
      height: 48,
      rotation: 0,
    });
  });

  it("canonically fits rotated stroked transforms and clears stale no-op previews", () => {
    const edge: PortalElement = {
      ...base("edge", "边缘矩形", 0),
      type: "RECT",
      x: 1_290,
      y: 820,
      width: 100,
      height: 50,
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: "#112233",
      strokeWidth: 4,
      dash: "SOLID",
      shadow: null,
    };
    let latestState = state(scene([edge]), { selection: ["edge"] });

    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, latestState);
      latestState = editorState;
      return <EditorStage state={editorState} dispatch={dispatch} />;
    }

    render(<Harness />);
    let group = konvaHarness.groups.get("portal-element-edge")!;
    act(() => {
      (group.props.onTransformStart as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    group = konvaHarness.groups.get("portal-element-edge")!;
    act(() => {
      group.node.scaleX(4);
      group.node.scaleY(3);
      group.node.rotation(45);
      (group.props.onTransform as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    const livePatch = normalizeNodeTransform(edge, {
      x: group.node.x(),
      y: group.node.y(),
      scaleX: group.node.scaleX(),
      scaleY: group.node.scaleY(),
      rotation: group.node.rotation(),
    });
    const liveBounds = elementBounds({ ...edge, ...livePatch });
    expect(liveBounds.x).toBeGreaterThanOrEqual(0);
    expect(liveBounds.y).toBeGreaterThanOrEqual(0);
    expect(liveBounds.x + liveBounds.width).toBeLessThanOrEqual(1_440);
    expect(liveBounds.y + liveBounds.height).toBeLessThanOrEqual(900);
    act(() => {
      group = konvaHarness.groups.get("portal-element-edge")!;
      (group.props.onTransformEnd as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });

    expect(portalSceneV1Schema.safeParse(latestState.present).success).toBe(true);
    const fitted = latestState.present.elements[0]!;
    const bounds = elementBounds(fitted);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1_440);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
    expect(latestState.past).toHaveLength(1);
    expect(latestState.transientPreview).toBeNull();

    const stale = editorReducer(latestState, {
      type: "PREVIEW_ELEMENT",
      id: "edge",
      patch: { x: fitted.x + 5 },
    });
    cleanup();
    latestState = stale;
    render(<Harness />);
    group = konvaHarness.groups.get("portal-element-edge")!;
    act(() => {
      (group.props.onTransformStart as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    group = konvaHarness.groups.get("portal-element-edge")!;
    act(() => {
      group.node.x(fitted.x + fitted.width / 2);
      group.node.y(fitted.y + fitted.height / 2);
      group.node.scaleX(1);
      group.node.scaleY(1);
      group.node.rotation(fitted.rotation);
      (group.props.onTransformEnd as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    expect(latestState.transientPreview).toBeNull();
    expect(latestState.past).toHaveLength(1);
  });

  it("canonically fits oversized rotated arrowhead bounds", () => {
    const arrow = {
      ...elements.find((element): element is Extract<PortalElement, { type: "ARROW" }> =>
        element.type === "ARROW")!,
      x: 100,
      y: 100,
      zIndex: 0,
    };
    const arrowScene = scene([arrow]);
    const fitted = normalizeTransformedElement(arrowScene, arrow, {
      x: -200,
      y: -100,
      width: 2_000,
      height: 1_000,
      rotation: 225,
    });
    const bounds = elementBounds(fitted);

    expect(portalSceneV1Schema.safeParse({
      ...arrowScene,
      elements: [fitted],
    }).success).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1_440);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
  });

  it("snaps shared rendered bounds in design coordinates without depending on zoom", () => {
    const moving = { ...elements[0]!, x: 713, y: 200, width: 20, height: 20 };
    const canvasCenter = snapElementPosition(moving, { x: 713, y: 200 }, [], "DESKTOP");
    expect(canvasCenter.patch.x).toBe(710);
    expect(canvasCenter.guides).toContainEqual({ axis: "VERTICAL", value: 720 });

    const other = { ...elements[1]!, x: 100, y: 200, width: 100, height: 40 };
    const otherEdge = snapElementPosition(
      { ...moving, x: 203 },
      { x: 203, y: 200 },
      [other],
      "DESKTOP",
    );
    expect(otherEdge.patch.x).toBe(203);

    const locked = { ...other, x: 300, locked: true };
    const ignoredLockedGuide = snapElementPosition(
      { ...moving, x: 303 },
      { x: 303, y: 200 },
      [locked],
      "DESKTOP",
    );
    expect(ignoredLockedGuide.patch.x).toBe(303);
  });

  it("wires zoomed drag snapping to a design-coordinate guide and one reducer history entry", () => {
    const moving = {
      ...elements[0]!,
      x: 713,
      y: 200,
      width: 20,
      height: 20,
      zIndex: 0,
    };
    let latestState = state(scene([moving]), { zoom: 2 });
    function Harness() {
      const [editorState, dispatch] = useReducer(editorReducer, latestState);
      latestState = editorState;
      return <EditorStage state={editorState} dispatch={dispatch} />;
    }

    render(<Harness />);
    let group = konvaHarness.groups.get("portal-element-text")!;
    group.node.x(723);
    group.node.y(210);
    act(() => {
      (group.props.onDragMove as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });

    const guide = konvaHarness.rendered.findLast(
      ({ kind, props }) => kind === "Line" && props.stroke === "#2563EB",
    );
    expect(guide?.props).toMatchObject({
      points: [720, 0, 720, 900],
      strokeWidth: 0.5,
      dash: [3, 2],
    });
    expect(screen.getByLabelText("对齐参考线").getAttribute("data-snap-value")).toBe("720");

    group = konvaHarness.groups.get("portal-element-text")!;
    act(() => {
      (group.props.onDragEnd as (event: { target: FakeKonvaNode }) => void)({ target: group.node });
    });
    expect(latestState.present.elements[0]?.x).toBe(710);
    expect(latestState.past).toHaveLength(1);
    expect(latestState.transientPreview).toBeNull();
    expect(screen.queryByLabelText("对齐参考线")).toBeNull();
  });
});
