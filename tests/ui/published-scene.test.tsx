// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublishedScene } from "@/features/portal/components/published-scene";
import type { PortalElement, PortalSceneV1 } from "@/features/portal/portal-scene";

let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const base = (id: string, zIndex: number) => ({
  id,
  name: id,
  x: 10 + zIndex * 3,
  y: 10 + zIndex * 3,
  width: 180,
  height: 80,
  rotation: 0,
  opacity: 1,
  zIndex,
  locked: false,
  hidden: false,
});

const shadow = {
  color: "#000000",
  opacity: 0.25,
  blur: 6,
  offsetX: 2,
  offsetY: 3,
} as const;

function allElements(): PortalElement[] {
  return [
    {
      ...base("text-action", 0),
      type: "TEXT",
      text: "员工手册",
      color: "#112233",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 22,
      fontWeight: 600,
      lineHeight: 1.5,
      align: "LEFT",
      italic: true,
      underline: true,
      letterSpacing: 1,
      backgroundColor: "#FFFFFF",
      action: { href: "/employee/policies", target: "_self" },
    },
    {
      ...base("rect", 1),
      type: "RECT",
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: "#112233",
      strokeWidth: 2,
      dash: "DASHED",
      shadow,
    },
    {
      ...base("circle", 2),
      type: "CIRCLE",
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: null,
      strokeWidth: 2,
      dash: "SOLID",
      shadow: null,
    },
    {
      ...base("ellipse", 3),
      type: "ELLIPSE",
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: "#112233",
      strokeWidth: 2,
      dash: "DOTTED",
      shadow: null,
    },
    {
      ...base("round-rect", 4),
      type: "ROUND_RECT",
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: "#112233",
      strokeWidth: 2,
      dash: "SOLID",
      shadow: null,
      cornerRadius: 18,
    },
    {
      ...base("triangle", 5),
      type: "TRIANGLE",
      fillEnabled: true,
      fill: "#FFFFFF",
      lastFillColor: "#FFFFFF",
      stroke: "#112233",
      strokeWidth: 2,
      dash: "DOTTED",
      shadow,
    },
    {
      ...base("line", 6),
      type: "LINE",
      stroke: "#112233",
      strokeWidth: 4,
      dash: "DASHED",
      shadow: null,
    },
    {
      ...base("arrow", 7),
      type: "ARROW",
      stroke: "#112233",
      strokeWidth: 4,
      pointerLength: 16,
      pointerWidth: 14,
      dash: "SOLID",
      shadow,
    },
    {
      ...base("image-action", 8),
      type: "IMAGE",
      assetId: "asset/office map",
      altText: "办公室地图",
      fitMode: "COVER",
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
      cornerRadius: 12,
      action: { href: "https://example.com/rooms", target: "_blank" },
    },
    {
      ...base("icon-action", 9),
      type: "ICON",
      iconName: "MapPin",
      color: "#0066CC",
      action: { href: "/employee/guides", target: "_self" },
    },
    {
      ...base("button-action", 10),
      type: "BUTTON",
      text: "查看会议室",
      backgroundColor: "#0066CC",
      cornerRadius: 12,
      action: { href: "https://example.com/meeting", target: "_blank" },
      color: "#FFFFFF",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 18,
      fontWeight: 700,
      lineHeight: 1.2,
      align: "CENTER",
      border: { color: "#FFFFFF", width: 2, dash: "SOLID" },
      shadow,
    },
    {
      ...base("marker", 11),
      type: "MARKER",
      text: "前台",
      color: "#FFFFFF",
      backgroundColor: "#0066CC",
      iconName: "Info",
      title: "前台详情",
      description: "一楼大厅右侧领取访客卡。",
    },
    {
      ...base("hidden", 12),
      type: "TEXT",
      text: "不能看到我",
      color: "#112233",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 18,
      fontWeight: 400,
      lineHeight: 1.2,
      align: "LEFT",
      italic: false,
      underline: false,
      letterSpacing: 0,
      backgroundColor: null,
      action: null,
      hidden: true,
    },
    {
      ...base("transparent", 13),
      type: "TEXT",
      text: "也不能看到我",
      color: "#112233",
      fontFamily: "Noto Sans SC Variable",
      fontSize: 18,
      fontWeight: 400,
      lineHeight: 1.2,
      align: "LEFT",
      italic: false,
      underline: false,
      letterSpacing: 0,
      backgroundColor: null,
      action: null,
      opacity: 0,
    },
  ];
}

function scene(): PortalSceneV1 {
  return {
    sceneVersion: 1,
    viewport: "DESKTOP",
    requiresMobileReview: false,
    background: {
      assetId: "background/floor plan",
      fitMode: "COVER",
      positionX: 25,
      positionY: 75,
      backgroundColor: "#F4F8FA",
      locked: false,
    },
    elements: allElements(),
  };
}

function sceneWith(
  elements: PortalElement[],
  viewport: "DESKTOP" | "MOBILE" = "DESKTOP",
): PortalSceneV1 {
  return {
    ...scene(),
    viewport,
    elements: elements.map((element, zIndex) => ({ ...element, zIndex })),
  };
}

function resize(width: number) {
  act(() => {
    resizeCallback?.(
      [{ contentRect: { width } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

describe("PublishedScene", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    resizeCallback = null;
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders all twelve scene element types semantically without editor or canvas runtime", () => {
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    resize(1_440);

    expect(screen.getByRole("region", { name: "四城门户发布版本 7" })).toBeTruthy();
    expect(container.querySelectorAll("[data-portal-element-type]")).toHaveLength(12);
    expect(new Set(
      [...container.querySelectorAll("[data-portal-element-type]")]
        .map((element) => element.getAttribute("data-portal-element-type")),
    )).toEqual(new Set([
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
    ]));
    expect(container.querySelectorAll("svg[data-portal-vector]")).toHaveLength(2);
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByTestId("portal-editor-controls")).toBeNull();
    expect(screen.queryByText("不能看到我")).toBeNull();
    expect(screen.queryByText("也不能看到我")).toBeNull();
  });

  it("uses protected encoded assets, canonical image crop and safe link attributes", () => {
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    resize(1_440);

    const image = screen.getByAltText("办公室地图") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/files/asset%2Foffice%20map");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1_000 },
      naturalHeight: { configurable: true, value: 500 },
    });
    fireEvent.load(image);
    expect(image.style.width).not.toBe("");
    expect(image.style.left).not.toBe("");

    const background = container.querySelector("[data-testid='published-scene-plane']");
    expect(background?.getAttribute("style")).toContain(
      "/api/files/background%2Ffloor%20plan",
    );
    const meetingLink = screen.getByRole("link", { name: "查看会议室" });
    expect(meetingLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(meetingLink.getAttribute("target")).toBe("_blank");
  });

  it("applies the complete button and CSS triangle visual contracts", () => {
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    resize(1_440);

    const meetingLink = screen.getByRole("link", { name: "查看会议室" });
    expect(meetingLink.style.color).toBe("rgb(255, 255, 255)");
    expect(meetingLink.style.fontFamily).toContain("Noto Sans SC Variable");
    expect(meetingLink.style.fontSize).toBe("18px");
    expect(meetingLink.style.fontWeight).toBe("700");
    expect(meetingLink.style.lineHeight).toBe("1.2");
    expect(meetingLink.style.borderRadius).toBe("12px");
    const buttonVisual = meetingLink.querySelector("[data-portal-visual-box]") as HTMLElement;
    const buttonFill = buttonVisual.querySelector("span") as HTMLElement;
    const buttonStroke = buttonVisual.querySelector("[data-portal-stroke]") as HTMLElement;
    const buttonText = buttonVisual.querySelector("[data-button-text]") as HTMLElement;
    expect(buttonVisual.style.width).toBe("100%");
    expect(buttonVisual.style.height).toBe("100%");
    expect(buttonVisual.style.borderRadius).toBe("12px");
    expect(buttonVisual.style.filter).toContain("rgba(0, 0, 0, 0.25)");
    expect(buttonFill.style.backgroundColor).toBe("rgb(0, 102, 204)");
    expect(buttonStroke.style.left).toBe("-1px");
    expect(buttonStroke.style.top).toBe("-1px");
    expect(buttonStroke.style.width).toBe("calc(100% + 2px)");
    expect(buttonStroke.style.height).toBe("calc(100% + 2px)");
    expect(buttonStroke.style.borderRadius).toBe("13px");
    expect(buttonStroke.style.border).toContain("2px solid rgb(255, 255, 255)");
    expect(buttonText.style.textAlign).toBe("center");

    const triangle = container.querySelector(
      "[data-portal-element-type='TRIANGLE'] > [data-portal-visual-box]",
    ) as HTMLElement;
    expect(triangle.style.filter).toContain("drop-shadow");
    expect(triangle.querySelector("svg")).toBeNull();
    expect(window.getComputedStyle(triangle).display).toBe("block");
    expect(window.getComputedStyle(
      container.querySelector("[data-portal-element-type='RECT'] > span")!,
    ).display).toBe("block");
    expect(window.getComputedStyle(
      container.querySelector("[data-portal-element-type='IMAGE'] span")!,
    ).display).toBe("block");
  });

  it("separates responsive visual boxes from absolute 44px hit slop", () => {
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    const wrapper = screen.getByRole("region", { name: "四城门户发布版本 7" });
    const plane = screen.getByTestId("published-scene-plane");

    resize(390);
    expect(parseFloat(wrapper.style.height)).toBeCloseTo(243.75);
    expect(plane.style.transform).toContain("scale(0.270833");
    const action = screen.getByRole("link", { name: "查看会议室" });
    const visual = action.querySelector("[data-portal-visual-box]") as HTMLElement;
    const hitSlop = action.querySelector("[data-portal-hit-slop]") as HTMLElement;
    expect(action.style.width).toBe("100%");
    expect(action.style.height).toBe("100%");
    expect(action.style.minWidth).toBe("");
    expect(action.style.minHeight).toBe("");
    expect(visual.style.width).toBe("100%");
    expect(visual.style.height).toBe("100%");
    expect(parseFloat(hitSlop.style.width) * (390 / 1_440)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(hitSlop.style.height) * (390 / 1_440)).toBeGreaterThanOrEqual(44);

    resize(1_800);
    expect(wrapper.style.height).toBe("900px");
    expect(plane.style.transform).toBe("scale(1)");
    expect(parseFloat(hitSlop.style.width)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(hitSlop.style.height)).toBeGreaterThanOrEqual(44);
    expect(container.querySelector("[data-testid='published-scene-plane']")).toBeTruthy();
  });

  it.each([
    ["DESKTOP", 1_440, 900, 45],
    ["DESKTOP", 1_440, 900, 90],
    ["MOBILE", 390, 844, 45],
    ["MOBILE", 390, 844, 90],
  ] as const)(
    "keeps a rotated 24px corner visual unchanged and clamps its 44px hit target",
    (viewport, canvasWidth, canvasHeight, rotation) => {
    const icon = allElements()[9] as Extract<PortalElement, { type: "ICON" }>;
    const radians = rotation * Math.PI / 180;
    const rotatedExtent = 24 *
      (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
    const inset = (rotatedExtent - 24) / 2;
    const icons = [
      { ...icon, id: "top-left", name: "top-left", x: inset, y: inset },
      {
        ...icon,
        id: "top-right",
        name: "top-right",
        x: canvasWidth - 24 - inset,
        y: inset,
      },
      {
        ...icon,
        id: "bottom-left",
        name: "bottom-left",
        x: inset,
        y: canvasHeight - 24 - inset,
      },
      {
        ...icon,
        id: "bottom-right",
        name: "bottom-right",
        x: canvasWidth - 24 - inset,
        y: canvasHeight - 24 - inset,
      },
    ].map((entry) => ({ ...entry, width: 24, height: 24, rotation }));
    const { container } = render(
      <PublishedScene scene={sceneWith(icons, viewport)} version={9} />,
    );
    resize(390);

    const scale = Math.min(1, 390 / canvasWidth);
    const wrappers = [...container.querySelectorAll<HTMLElement>(
      "[data-portal-element-type='ICON']",
    )];
    expect(wrappers).toHaveLength(4);
    for (const wrapper of wrappers) {
      const action = wrapper.querySelector("a") as HTMLElement;
      const hitSlop = action.querySelector("[data-portal-hit-slop]") as HTMLElement;
      const expected = icons.find(({ id }) => id === action.dataset.portalElementId)!;
      const elementLeft = parseFloat(wrapper.style.left);
      const elementTop = parseFloat(wrapper.style.top);
      const localLeft = parseFloat(hitSlop.style.left);
      const localTop = parseFloat(hitSlop.style.top);
      const width = parseFloat(hitSlop.style.width);
      const height = parseFloat(hitSlop.style.height);
      const center = { x: 12, y: 12 };
      const corners = [
        [localLeft, localTop],
        [localLeft + width, localTop],
        [localLeft + width, localTop + height],
        [localLeft, localTop + height],
      ].map(([x, y]) => ({
        x: elementLeft + center.x + (x! - center.x) * Math.cos(radians) -
          (y! - center.y) * Math.sin(radians),
        y: elementTop + center.y + (x! - center.x) * Math.sin(radians) +
          (y! - center.y) * Math.cos(radians),
      }));
      expect(wrapper.style.width).toBe("24px");
      expect(wrapper.style.height).toBe("24px");
      expect(elementLeft).toBeCloseTo(expected.x, 5);
      expect(elementTop).toBeCloseTo(expected.y, 5);
      expect(wrapper.style.transform).toBe(`rotate(${rotation}deg)`);
      expect(hitSlop.style.transform).toBe("");
      expect(Math.min(...corners.map(({ x }) => x))).toBeGreaterThanOrEqual(-0.001);
      expect(Math.min(...corners.map(({ y }) => y))).toBeGreaterThanOrEqual(-0.001);
      expect(Math.max(...corners.map(({ x }) => x))).toBeLessThanOrEqual(
        canvasWidth + 0.001,
      );
      expect(Math.max(...corners.map(({ y }) => y))).toBeLessThanOrEqual(
        canvasHeight + 0.001,
      );
      expect(width * scale).toBeGreaterThanOrEqual(44);
      expect(height * scale).toBeGreaterThanOrEqual(44);
    }
  });

  it("renders a continuous dashed rectangle path without resetting phase at corners", () => {
    const thick = {
      ...allElements()[1],
      id: "thick-rotated",
      x: 200,
      y: 200,
      width: 240,
      height: 140,
      rotation: 30,
      strokeWidth: 40,
      dash: "DASHED",
      shadow,
    } as PortalElement;
    const { container } = render(
      <PublishedScene scene={sceneWith([thick])} version={10} />,
    );
    resize(1_440);

    const wrapper = container.querySelector("[data-portal-element-type='RECT']") as HTMLElement;
    const fill = wrapper.querySelector("[data-portal-fill]") as HTMLElement;
    const stroke = wrapper.querySelector("[data-dom-stroke-path]") as HTMLElement;
    expect(fill.style.width).toBe("100%");
    expect(fill.style.height).toBe("100%");
    expect(stroke.dataset.dashPattern).toBe("160 120");
    expect(stroke.querySelectorAll("*")).toHaveLength(0);
    expect(Number(stroke.dataset.groupCount)).toBeGreaterThan(1);
    expect(Number(stroke.dataset.segmentCount)).toBeGreaterThan(3);
    expect(stroke.style.clipPath).toContain("M ");
    expect(stroke.style.clipPath).toContain("L ");
    expect(stroke.style.clipPath).toContain("Z");
  });

  it("merges an active dash across a closed-path seam and draws its corner join", () => {
    const rect = {
      ...(allElements()[1] as Extract<PortalElement, { type: "RECT" }>),
      x: 100,
      y: 100,
      width: 900,
      height: 600,
      strokeWidth: 100,
      dash: "DASHED" as const,
      shadow: null,
    };
    const { container } = render(
      <PublishedScene scene={sceneWith([rect])} version={14} />,
    );
    resize(1_440);
    const stroke = container.querySelector("[data-dom-stroke-path]") as HTMLElement;
    expect(stroke.dataset.groupCount).toBe("4");
    expect(stroke.style.clipPath).toContain("M 0 50 A 50 50");
  });

  it("samples dotted ellipses and rounded corners into real continuous DOM path segments", () => {
    const ellipse = allElements()[3] as Extract<PortalElement, { type: "ELLIPSE" }>;
    const roundRect = {
      ...(allElements()[4] as Extract<PortalElement, { type: "ROUND_RECT" }>),
      dash: "DASHED" as const,
    };
    const button = {
      ...(allElements()[10] as Extract<PortalElement, { type: "BUTTON" }>),
      border: { color: "#FFFFFF", width: 2, dash: "DASHED" as const },
    };
    const { container } = render(
      <PublishedScene scene={sceneWith([ellipse, roundRect, button])} version={7} />,
    );
    resize(1_440);
    for (const type of ["ELLIPSE", "ROUND_RECT", "BUTTON"]) {
      const path = container.querySelector(
        `[data-portal-element-type='${type}'] [data-dom-stroke-path]`,
      ) as HTMLElement;
      expect(path).toBeTruthy();
      expect(path.querySelectorAll("*")).toHaveLength(0);
      expect(path.style.clipPath).toContain("L ");
      expect(path.style.clipPath).toContain("A ");
      expect(path.style.clipPath).not.toContain("NaN");
    }
  });

  it("renders a solid triangle with round joins and no shape SVG", () => {
    const triangle = {
      ...(allElements()[5] as Extract<PortalElement, { type: "TRIANGLE" }>),
      dash: "SOLID" as const,
    };
    const { container } = render(
      <PublishedScene scene={sceneWith([triangle])} version={7} />,
    );
    resize(1_440);
    const root = container.querySelector("[data-portal-element-type='TRIANGLE']");
    const stroke = root?.querySelector("[data-dom-stroke-path]") as HTMLElement;
    expect(stroke.querySelectorAll("*")).toHaveLength(0);
    expect(stroke.style.clipPath.match(/A /g)).toHaveLength(6);
    expect(stroke.dataset.groupCount).toBe("1");
    expect(root?.querySelector("svg")).toBeNull();
  });

  it("bounds 200 maximum-size thin dotted shapes to 256 temporary pieces each", () => {
    const rect = allElements()[1] as Extract<PortalElement, { type: "RECT" }>;
    const shapes = Array.from({ length: 200 }, (_, index) => ({
      ...rect,
      id: `thin-${index}`,
      name: `thin-${index}`,
      x: 1,
      y: 1,
      width: 1_438,
      height: 898,
      strokeWidth: 0.5,
      dash: "DOTTED" as const,
      shadow: null,
    }));
    const { container } = render(
      <PublishedScene scene={sceneWith(shapes)} version={13} />,
    );
    resize(1_440);
    const strokes = [...container.querySelectorAll<HTMLElement>(
      "[data-dom-stroke-path]",
    )];
    expect(strokes).toHaveLength(200);
    expect(strokes.every((stroke) => stroke.querySelectorAll("*").length === 0))
      .toBe(true);
    expect(strokes.every((stroke) => stroke.style.clipPath.length <= 24_000))
      .toBe(true);
    expect(strokes.every((stroke) =>
      stroke.style.clipPath !== "" ||
      ["path-budget", "piece-budget"].includes(stroke.dataset.strokeFallback ?? "")
    )).toBe(true);
    expect(strokes.reduce(
      (total, stroke) => total + Number(stroke.dataset.segmentCount),
      0,
    )).toBeLessThanOrEqual(200 * 256);
  });

  it("uses a visible bounded side fallback when a dotted triangle exceeds the piece budget", () => {
    const triangle = {
      ...(allElements()[5] as Extract<PortalElement, { type: "TRIANGLE" }>),
      x: 200,
      y: 100,
      width: 1_000,
      height: 700,
      strokeWidth: 0.5,
      dash: "DOTTED" as const,
      shadow: null,
    };
    const { container } = render(
      <PublishedScene scene={sceneWith([triangle])} version={15} />,
    );
    resize(1_440);
    const stroke = container.querySelector("[data-dom-stroke-path]") as HTMLElement;
    expect(stroke.dataset.strokeFallback).toBe("piece-budget");
    const sides = [...stroke.querySelectorAll<HTMLElement>("[data-fallback-side]")];
    expect(sides).toHaveLength(3);
    expect(sides.every((side) =>
      side.style.background.includes("repeating-linear-gradient")
    )).toBe(true);
    expect(sides.every((side) => parseFloat(side.style.width) > 0)).toBe(true);
  });

  it("renders an ARROW with a filled generated head at the exact pointer endpoints", () => {
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    resize(1_440);
    const arrow = allElements()[7] as Extract<PortalElement, { type: "ARROW" }>;
    const length = Math.hypot(arrow.width, arrow.height);
    const unitX = arrow.width / length;
    const unitY = arrow.height / length;
    const baseX = arrow.width - unitX * arrow.pointerLength;
    const baseY = arrow.height - unitY * arrow.pointerLength;
    const left = `${baseX - unitY * arrow.pointerWidth / 2},${baseY + unitX * arrow.pointerWidth / 2}`;
    const right = `${baseX + unitY * arrow.pointerWidth / 2},${baseY - unitX * arrow.pointerWidth / 2}`;
    const head = container.querySelector(
      "[data-portal-vector='ARROW'] polygon[data-arrow-head]",
    );
    expect(head).toBeTruthy();
    expect(head?.getAttribute("points")).toBe(
      `${left} ${arrow.width},${arrow.height} ${right}`,
    );
    expect(head?.getAttribute("fill")).toBe(arrow.stroke);
    expect(container.querySelector("[data-portal-vector='ARROW'] polyline")).toBeNull();
  });

  it("maps BUTTON LEFT, CENTER and RIGHT onto full-width text alignment", () => {
    const button = allElements()[10] as Extract<PortalElement, { type: "BUTTON" }>;
    const buttons = (["LEFT", "CENTER", "RIGHT"] as const).map((align, index) => ({
      ...button,
      id: `button-${align}`,
      name: align,
      text: align,
      align,
      x: 20,
      y: 20 + index * 100,
      zIndex: index,
    }));
    render(<PublishedScene scene={sceneWith(buttons)} version={11} />);
    resize(1_440);

    expect(screen.getByRole("link", { name: "LEFT" }).style.justifyContent).toBe("flex-start");
    expect(screen.getByRole("link", { name: "CENTER" }).style.justifyContent).toBe("center");
    expect(screen.getByRole("link", { name: "RIGHT" }).style.justifyContent).toBe("flex-end");
    for (const align of ["LEFT", "CENTER", "RIGHT"]) {
      const text = screen.getByRole("link", { name: align })
        .querySelector("[data-button-text]") as HTMLElement;
      expect(text.style.width).toBe("100%");
      expect(text.style.textAlign).toBe(align.toLowerCase());
    }
  });

  it("keeps long marker disclosures inside the available room at all canvas corners", async () => {
    const user = userEvent.setup();
    const marker = allElements()[11] as Extract<PortalElement, { type: "MARKER" }>;
    const description = "详".repeat(500);
    const markers = [
      { ...marker, id: "top left marker", x: 0, y: 0, name: "左上", title: `左上${"题".repeat(118)}` },
      { ...marker, id: "top right marker", x: 1_260, y: 0, name: "右上", title: `右上${"题".repeat(118)}` },
      { ...marker, id: "bottom left marker", x: 0, y: 820, name: "左下", title: `左下${"题".repeat(118)}` },
      { ...marker, id: "bottom right marker", x: 1_260, y: 820, name: "右下", title: `右下${"题".repeat(118)}` },
    ].map((entry, zIndex) => ({ ...entry, description, zIndex })) as PortalElement[];
    render(<PublishedScene scene={sceneWith(markers)} version={12} />);
    resize(1_440);

    const expectedPlacements = [
      [`左上${"题".repeat(118)}`, "BOTTOM", "LEFT", 810],
      [`右上${"题".repeat(118)}`, "BOTTOM", "RIGHT", 810],
      [`左下${"题".repeat(118)}`, "TOP", "LEFT", 810],
      [`右下${"题".repeat(118)}`, "TOP", "RIGHT", 810],
    ] as const;
    for (const [title, vertical, horizontal, room] of expectedPlacements) {
      const control = screen.getByRole("button", { name: title });
      const controls = control.getAttribute("aria-controls")!;
      expect(controls).not.toContain(" ");
      expect(controls).not.toContain(title);
      await user.click(control);
      const disclosure = document.getElementById(controls)!;
      expect(disclosure).toBeTruthy();
      expect(disclosure.dataset.vertical).toBe(vertical);
      expect(disclosure.dataset.horizontal).toBe(horizontal);
      expect(parseFloat(disclosure.style.maxHeight)).toBe(room);
      expect(parseFloat(disclosure.style.maxWidth)).toBeLessThanOrEqual(1_420);
      expect(disclosure.style.boxSizing).toBe("border-box");
      expect(disclosure.style.overflowY).toBe("auto");
      expect(disclosure.style.overflowWrap).toBe("anywhere");
    }
  });

  it("keeps natural z-order tabbing and exposes marker disclosure to keyboard users", async () => {
    const user = userEvent.setup();
    const { container } = render(<PublishedScene scene={scene()} version={7} />);
    resize(1_440);

    expect(
      [...container.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>("a, button")]
        .map((element) => element.dataset.portalElementId),
    ).toEqual(["text-action", "image-action", "icon-action", "button-action", "marker"]);

    const marker = screen.getByRole("button", { name: "前台详情" });
    expect(marker.getAttribute("aria-expanded")).toBe("false");
    await user.click(marker);
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("一楼大厅右侧领取访客卡。")).toBeTruthy();
    expect(marker.className).toContain("interactive");
  });

  it("fails closed with a recoverable message when a V1 scene is invalid", () => {
    const invalid = {
      ...scene(),
      elements: [
        {
          ...allElements()[0],
          text: "<script>alert(1)</script>",
        },
      ],
    };

    const { container } = render(<PublishedScene scene={invalid} version={8} />);
    expect(screen.getByRole("alert").textContent).toContain("发布内容暂时无法显示");
    expect(container.querySelector("[data-portal-element-type]")).toBeNull();
    expect(container.innerHTML).not.toContain("<script>");
  });

  it("renders closed shapes without fill while keeping stroke when fillEnabled is false", () => {
    const hollowShapes = (
      ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"] as const
    ).map((type, index) => ({
      ...base(type.toLowerCase(), index),
      type,
      fillEnabled: false as const,
      fill: null,
      lastFillColor: "#DCEBFA",
      stroke: "#1E88E5",
      strokeWidth: 3,
      dash: "SOLID" as const,
      shadow: null,
      ...(type === "ROUND_RECT" ? { cornerRadius: 12 } : {}),
    })) as PortalElement[];

    const { container } = render(<PublishedScene scene={sceneWith(hollowShapes)} version={9} />);
    resize(1_440);

    for (const type of ["RECT", "CIRCLE", "ELLIPSE", "ROUND_RECT", "TRIANGLE"]) {
      const root = container.querySelector(
        `[data-portal-element-type='${type}'] > [data-portal-visual-box]`,
      ) as HTMLElement;
      expect(root).toBeTruthy();
      const fill = root.querySelector("[data-portal-fill]") as HTMLElement | null;
      if (fill) {
        const background = fill.style.background || fill.style.backgroundColor;
        expect(background === "" || background === "transparent" || background === "rgba(0, 0, 0, 0)")
          .toBe(true);
      }
      expect(root.querySelector("[data-portal-stroke], [data-dom-stroke-path]")).toBeTruthy();
    }
  });

  it("renders FREEHAND as a vector path with round stroke style", () => {
    const freehandScene = sceneWith([{
      ...base("freehand", 0),
      type: "FREEHAND",
      width: 160,
      height: 90,
      points: [0, 20, 40, 0, 90, 70, 160, 90],
      stroke: "#1E88E5",
      strokeWidth: 4,
      tension: 0.4,
      lineCap: "ROUND",
      lineJoin: "ROUND",
    }]);
    const { container } = render(<PublishedScene scene={freehandScene} version={16} />);
    resize(1_440);

    const node = container.querySelector("[data-portal-element-type='FREEHAND']");
    const vector = container.querySelector("svg[data-portal-vector='FREEHAND']");
    const path = vector?.querySelector("path");
    expect(node).toBeTruthy();
    expect(vector).toBeTruthy();
    expect(path).toBeTruthy();
    expect(path?.getAttribute("stroke")).toBe("#1E88E5");
    expect(path?.getAttribute("stroke-linecap")).toBe("round");
    expect(path?.getAttribute("stroke-linejoin")).toBe("round");
    expect(path?.getAttribute("fill")).toBe("none");
    expect(path?.getAttribute("d")).toContain("C");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("renders an auto-height long background and elements with one responsive scale", () => {
    const longScene: PortalSceneV1 = {
      ...sceneWith([{
        ...base("roof", 0),
        type: "TEXT",
        y: 5_200,
        text: "楼顶",
        color: "#112233",
        fontFamily: "Noto Sans SC Variable",
        fontSize: 24,
        fontWeight: 600,
        lineHeight: 1.4,
        align: "LEFT",
        italic: false,
        underline: false,
        letterSpacing: 0,
        backgroundColor: null,
        action: null,
      }]),
      background: {
        ...scene().background,
        fitMode: "AUTO_HEIGHT",
        naturalWidth: 1_625,
        naturalHeight: 6_375,
      },
    };
    const { container } = render(<PublishedScene scene={longScene} version={10} />);
    resize(720);

    const logicalHeight = 1_440 * 6_375 / 1_625;
    const region = screen.getByRole("region", { name: "四城门户发布版本 10" });
    const plane = screen.getByTestId("published-scene-plane");
    const roof = container.querySelector("[data-portal-element-id='roof']") as HTMLElement;
    expect(Number.parseFloat(region.style.height)).toBeCloseTo(logicalHeight * 0.5, 8);
    expect(Number.parseFloat(region.style.getPropertyValue("--portal-design-height"))).toBeCloseTo(logicalHeight, 8);
    expect(plane.style.backgroundSize).toBe("100%");
    expect(plane.style.backgroundPosition).toBe("left top");
    expect(plane.style.transform).toBe("scale(0.5)");
    expect(roof.style.top).toBe("5200px");
  });
});
