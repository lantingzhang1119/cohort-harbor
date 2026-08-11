import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";

import type { PortalSceneV1 } from "../src/features/portal/portal-scene";
import { validPng } from "../tests/fixtures/portal-images";
import {
  assertHighInformationCrop,
  locateColorMaskBounds,
  locateColorStrokeEndpoints,
  measureImageContentStats,
  rgbaPixelDiffRatio,
} from "../tests/visual/portal-pixel-diff";

const ARTIFACT_DIR = path.join(process.cwd(), "artifacts", "portal-editor");
const OFFICE_MAP_FIXTURE = path.join(process.cwd(), "tests/fixtures/office-map.png");
const OFFICE_MAP_SHA256 =
  "500cd332e592bd61d227d5ab1a9c5355f0da81d27afc44759d7cf11710fe95fc";
const DESIGN = {
  DESKTOP: { width: 1_440, height: 900 },
  MOBILE: { width: 390, height: 844 },
} as const;

/**
 * High-information crops on the CONTAIN-fitted synthetic test map (not letterbox).
 * Desktop image band starts ~x=373; mobile image band starts ~y=169.
 * Elements for geometry are placed away from these windows.
 */
const HIGH_INFO_CROP_DESIGN = {
  DESKTOP: { x: 720, y: 380, width: 80, height: 80 },
  MOBILE: { x: 155, y: 360, width: 72, height: 72 },
} as const;
/** Pixel-diff threshold: differing RGB pixels / total pixels must stay under 1%. */
const PIXEL_DIFF_LIMIT = 0.01;
/** Unique high-contrast paints for real visual geometry (Konva / published). */
const GEOM_RECT_FILL = "#FF00FF";
const GEOM_RECT_RGB = { r: 255, g: 0, b: 255 };
/** Pure red avoids office-map palette false positives that cyan/teal can trigger. */
const GEOM_ARROW_STROKE = "#FF0000";
const GEOM_ARROW_RGB = { r: 255, g: 0, b: 0 };

const REQUIRED_SCREENSHOTS = [
  "pc-editor.png",
  "mobile-editor.png",
  "background-panel.png",
  "component-panel.png",
  "selected-text.png",
  "selected-shape.png",
  "office-map.png",
  "employee-pc.png",
  "employee-mobile.png",
] as const;

async function login(page: Page, username: string, password: string) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("姓名 / 工号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录平台" }).click();
  await page.waitForURL(/\/(admin|employee)(\/|$)/, { timeout: 20_000 });
}

async function logout(page: Page) {
  const logoutButton = page.getByRole("button", { name: "退出登录" });
  if (await logoutButton.count()) {
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login$/);
    return;
  }
  await page.goto("/login", { waitUntil: "domcontentloaded" });
}

async function waitEditorReady(page: Page) {
  await expect(page.getByLabel("四城门户可视化编辑器")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/草稿已加载|草稿已保存|已复制|已发布|已恢复/)).toBeVisible({
    timeout: 30_000,
  });
}

async function saveVisualDraft(page: Page) {
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/草稿已保存/)).toBeVisible();
}

async function captureArtifact(page: Page, name: (typeof REQUIRED_SCREENSHOTS)[number]) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const target = path.join(ARTIFACT_DIR, name);
  await page.screenshot({ path: target, fullPage: true, animations: "disabled" });
  const stats = statSync(target);
  expect(stats.size, `${name} must not be empty`).toBeGreaterThan(8_000);
}

async function assertNoAdminSidebar(page: Page) {
  await expect(page.getByLabel("管理员侧栏")).toHaveCount(0);
  await expect(page.locator(".admin-sidebar")).toHaveCount(0);
}

async function assertNoEmployeeEditControls(page: Page) {
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存并发布" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加组件" })).toHaveCount(0);
  await expect(page.getByLabel("选中元素控制框")).toHaveCount(0);
  await expect(page.getByLabel("添加组件面板")).toHaveCount(0);
}

async function openShanghaiDesktopEditor(page: Page) {
  await page.goto("/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP", {
    waitUntil: "domcontentloaded",
  });
  await waitEditorReady(page);
  await expect(page.getByRole("button", { name: "上海", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "桌面", exact: true })).toHaveAttribute("aria-pressed", "true");
  await assertNoAdminSidebar(page);
}

async function selectElementByLayer(page: Page, name: string) {
  await page.getByRole("button", { name: "图层" }).click();
  await page.getByRole("button", { name: `选择 ${name}`, exact: true }).click();
  await expect(page.getByLabel("选中元素控制框")).toBeVisible();
}

async function readZoomPercent(page: Page) {
  const text = await page.getByLabel("缩放比例").textContent();
  return Number((text ?? "").replace("%", "").trim());
}

/** Drive editor zoom to 100% via real toolbar controls (no test-only window events). */
async function setEditorZoomTo100Percent(page: Page) {
  let percent = await readZoomPercent(page);
  for (let step = 0; step < 20 && percent !== 100; step += 1) {
    const before = percent;
    if (percent > 100) {
      await page.getByRole("button", { name: "缩小" }).click();
    } else {
      await page.getByRole("button", { name: "放大" }).click();
    }
    await expect.poll(async () => readZoomPercent(page), {
      message: `zoom label should change after toolbar click (was ${before}%)`,
    }).not.toBe(before);
    percent = await readZoomPercent(page);
  }
  expect(percent, "editor zoom should reach 100% via 缩小/放大 toolbar").toBe(100);
}

/**
 * Real DOM proof at extreme zoom-out: all 6 adjustment buttons are unclipped,
 * keyboard-focusable, and each click applies the intended geometry delta.
 */
async function assertAdjustmentOverlayUsableAtZoom(page: Page, targetPercent: number) {
  let percent = await readZoomPercent(page);
  for (let step = 0; step < 40 && percent !== targetPercent; step += 1) {
    if (percent > targetPercent) {
      await page.getByRole("button", { name: "缩小" }).click();
    } else {
      await page.getByRole("button", { name: "放大" }).click();
    }
    await expect.poll(async () => readZoomPercent(page)).not.toBe(percent);
    percent = await readZoomPercent(page);
  }
  expect(percent).toBe(targetPercent);

  const overlay = page.getByTestId("portal-adjustment-overlay");
  await expect(overlay).toBeVisible();
  const insideClip = await overlay.evaluate((node) => {
    const clip = document.querySelector('[data-testid="portal-editor-canvas-clip"]');
    return Boolean(clip && clip.contains(node));
  });
  expect(insideClip, "adjustment overlay must be outside overflow:hidden canvas clip").toBe(false);

  const buttons = overlay.getByRole("button");
  await expect(buttons).toHaveCount(6);
  // Order matches GEOMETRY_ADJUSTMENTS: 宽− 宽+ 高− 高+ ↶ ↷
  const intents = [
    { label: "宽度减少 1 像素", field: "w" as const, delta: -1 },
    { label: "宽度增加 1 像素", field: "w" as const, delta: 1 },
    { label: "高度减少 1 像素", field: "h" as const, delta: -1 },
    { label: "高度增加 1 像素", field: "h" as const, delta: 1 },
    { label: "逆时针旋转 1 度", field: "rotation" as const, delta: -1 },
    { label: "顺时针旋转 1 度", field: "rotation" as const, delta: 1 },
  ];

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index]!;
    const button = buttons.nth(index);
    await expect(button).toHaveAttribute("aria-label", intent.label);
    const box = await button.boundingBox();
    expect(box, `${intent.label} bounding box`).not.toBeNull();
    expect(box!.width).toBeGreaterThan(8);
    expect(box!.height).toBeGreaterThan(8);

    await button.focus();
    await expect(button).toBeFocused();

    const beforeGeom = await readGeometry(page);
    const beforeRotation = Number(await (await rotationField(page)).inputValue());
    await button.click();
    if (intent.field === "rotation") {
      await expect.poll(async () => Number(await (await rotationField(page)).inputValue()), {
        message: `${intent.label} should change rotation by ${intent.delta}`,
      }).toBe(beforeRotation + intent.delta);
    } else {
      await expect.poll(async () => (await readGeometry(page))[intent.field], {
        message: `${intent.label} should change ${intent.field} by ${intent.delta}`,
      }).toBe(beforeGeom[intent.field] + intent.delta);
    }
  }
  // Neutralize residual 1° from ↶ then ↷ pair (net 0) — width/height also net 0.
  await (await rotationField(page)).fill("0");
}

async function dragSelectedElement(page: Page, deltaX: number, deltaY: number) {
  const handle = page.getByLabel("选中元素控制框");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  // Pointer targets the Konva canvas under the non-interactive a11y overlay.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 12 });
  await page.mouse.up();
}

/**
 * Real Konva Transformer bottom-right resize anchor (not 1px property buttons).
 * Anchor sits on the selection box corner; drag outward and assert W/H grow.
 */
async function resizeSelectedViaTransformer(page: Page) {
  const handle = page.getByLabel("选中元素控制框");
  await expect(handle).toBeVisible();
  const before = await readGeometry(page);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  // Hit slightly outside the a11y box so Konva Transformer SE anchor receives the drag.
  const startX = box!.x + box!.width + 4;
  const startY = box!.y + box!.height + 4;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 56, startY + 44, { steps: 16 });
  await page.mouse.up();
  await expect.poll(async () => {
    const next = await readGeometry(page);
    // Circles keep ratio; accept growth on either axis from real Transformer drag.
    return Math.max(next.w - before.w, next.h - before.h);
  }, { timeout: 10_000 }).toBeGreaterThan(6);
}

/**
 * Real Konva Transformer rotate anchor (default offset above top-center).
 * Not the 1° property chrome buttons.
 */
async function rotationField(page: Page) {
  return page.getByRole("spinbutton", { name: "旋转" });
}

async function rotateSelectedViaTransformer(page: Page) {
  const handle = page.getByLabel("选中元素控制框");
  await expect(handle).toBeVisible();
  const beforeRotation = Number(await (await rotationField(page)).inputValue());
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const rotX = box!.x + box!.width / 2;
  const rotY = box!.y - 52;
  await page.mouse.move(rotX, rotY);
  await page.mouse.down();
  await page.mouse.move(rotX + 56, rotY + 12, { steps: 16 });
  await page.mouse.up();
  await expect.poll(async () => {
    const value = Number(await (await rotationField(page)).inputValue());
    return Math.abs(value - beforeRotation);
  }, { timeout: 10_000 }).toBeGreaterThan(3);
}

/** Production keyboard nudge path (Arrow keys on the canvas workspace). */
async function nudgeSelectedElement(page: Page, steps = 12) {
  // Blur property/adjustment controls without clicking empty stage (that deselects).
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  const scope = page.getByLabel("画布工作区");
  await scope.focus();
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
  }
}

async function openGeometryPanel(page: Page) {
  const details = page.locator("aside[aria-label='属性面板'] details").filter({
    has: page.locator("summary", { hasText: "精确调整" }),
  });
  await expect(details).toHaveCount(1);
  await details.evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await expect(page.getByLabel("X", { exact: true })).toBeVisible();
}

async function readGeometry(page: Page) {
  await openGeometryPanel(page);
  return {
    x: Number(await page.getByLabel("X", { exact: true }).inputValue()),
    y: Number(await page.getByLabel("Y", { exact: true }).inputValue()),
    w: Number(await page.getByLabel("W", { exact: true }).inputValue()),
    h: Number(await page.getByLabel("H", { exact: true }).inputValue()),
  };
}

async function writeGeometry(
  page: Page,
  values: Partial<{ x: number; y: number; w: number; h: number }>,
) {
  await openGeometryPanel(page);
  if (values.x !== undefined) await page.getByLabel("X", { exact: true }).fill(String(values.x));
  if (values.y !== undefined) await page.getByLabel("Y", { exact: true }).fill(String(values.y));
  if (values.w !== undefined) await page.getByLabel("W", { exact: true }).fill(String(values.w));
  if (values.h !== undefined) await page.getByLabel("H", { exact: true }).fill(String(values.h));
}

async function uploadLogo(page: Page) {
  await page.getByLabel("上传 Logo 文件").setInputFiles({
    name: "portal.png",
    mimeType: "image/png",
    buffer: Buffer.from(validPng()),
  });
  await page.getByRole("button", { name: "上传 Logo", exact: true }).click();
  await expect(page.getByText(/Logo 已加入桌面布局/)).toBeVisible();
}

async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/草稿已保存/)).toBeVisible();
}

async function publishBothViewports(page: Page, city: string) {
  let resolveDialog!: () => void;
  let rejectDialog!: (error: unknown) => void;
  const handled = new Promise<void>((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; });
  page.once("dialog", async (dialog) => {
    try {
      expect(dialog.message()).toContain(`${city}的桌面（1440×900）和手机（390×844）最后保存的草稿`);
      await dialog.accept();
      resolveDialog();
    } catch (error) { rejectDialog(error); }
  });
  await page.getByRole("button", { name: "发布" }).click();
  await handled;
}

type DesignBox = { x: number; y: number; width: number; height: number };
type ViewportKind = "DESKTOP" | "MOBILE";

function assertOfficeMapFixture() {
  const bytes = readFileSync(OFFICE_MAP_FIXTURE);
  expect(bytes.byteLength, "office-map fixture must be non-empty").toBeGreaterThan(10_000);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(OFFICE_MAP_SHA256);
  expect(bytes.readUInt32BE(16), "office-map width").toBe(1_014);
  expect(bytes.readUInt32BE(20), "office-map height").toBe(1_314);
  return bytes;
}

type MeasuredBox = {
  /** Element box relative to the scene plane, in CSS px of the current layout. */
  css: DesignBox;
  /** Plane CSS size (width/height). */
  planeCss: { width: number; height: number };
  /** Design canvas size used for scale conversion. */
  design: { width: number; height: number };
  /** CSS px per design px on each axis (handles non-uniform subpixel plane sizes). */
  scaleX: number;
  scaleY: number;
};

type PaintSample = {
  png: Buffer;
  /** CSS origin of the bitmap relative to the design plane. */
  originCss: { x: number; y: number };
  /** Device pixels per CSS px in the bitmap. */
  dpr: number;
  planeCss: { width: number; height: number };
};

/**
 * Editor: read the Konva *elements* layer canvas via toDataURL (not Playwright
 * page-composited screenshot of canvas.first / transparent hit slab).
 * Published: greenscreen the scene plane so only element paint remains, then
 * capture plane pixels (no map background contamination).
 */
async function captureIsolatedPaintSample(
  page: Page,
  mode: "editor" | "published",
): Promise<PaintSample> {
  const planeSelector = mode === "editor"
    ? '[data-testid="portal-design-plane"]'
    : '[data-testid="published-scene-plane"]';
  const plane = page.locator(planeSelector);
  await expect(plane).toBeVisible();
  const planeBox = await plane.boundingBox();
  expect(planeBox).not.toBeNull();

  if (mode === "editor") {
    const sample = await page.evaluate(() => {
      const root = document.querySelector('[aria-label="门户画布"]');
      if (!(root instanceof HTMLElement)) return null;
      const canvases = [...root.querySelectorAll("canvas")];
      // Konva: one canvas per Layer (bg hit slab, elements, guides). Prefer the
      // canvas with the most non-transparent paint = elements layer.
      let best: HTMLCanvasElement | null = null;
      let bestPaint = 0;
      for (const canvas of canvases) {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let paint = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i]! > 16) paint += 1;
        }
        if (paint > bestPaint) {
          bestPaint = paint;
          best = canvas;
        }
      }
      if (!best || bestPaint < 12) return null;
      const rect = best.getBoundingClientRect();
      return {
        dataUrl: best.toDataURL("image/png"),
        originX: rect.x,
        originY: rect.y,
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelWidth: best.width,
        pixelHeight: best.height,
      };
    });
    expect(sample, "Konva elements-layer canvas with paint").not.toBeNull();
    const base64 = sample!.dataUrl.replace(/^data:image\/png;base64,/, "");
    const png = Buffer.from(base64, "base64");
    const dprX = sample!.pixelWidth / Math.max(1, sample!.cssWidth);
    const dprY = sample!.pixelHeight / Math.max(1, sample!.cssHeight);
    const dpr = (dprX + dprY) / 2;
    return {
      png,
      originCss: {
        x: sample!.originX - planeBox!.x,
        y: sample!.originY - planeBox!.y,
      },
      dpr,
      planeCss: { width: planeBox!.width, height: planeBox!.height },
    };
  }

  // Published: neutralize map background so color masks cannot match map pixels.
  await page.locator(".watermark-layer").evaluateAll((nodes) => {
    for (const node of nodes) (node as HTMLElement).style.visibility = "hidden";
  }).catch(() => undefined);
  await plane.evaluate((node) => {
    const el = node as HTMLElement;
    el.dataset.prevBgImage = el.style.backgroundImage;
    el.dataset.prevBgColor = el.style.backgroundColor;
    el.style.backgroundImage = "none";
    el.style.backgroundColor = "rgb(0, 255, 0)";
  });
  const sample = await page.evaluate((selector) => {
    const planeNode = document.querySelector(selector);
    if (!(planeNode instanceof HTMLElement)) return null;
    // Rasterize the plane (greenscreen + element paint only) via foreignObject-free path:
    // draw the plane to a canvas using html2canvas is unavailable; use SVG foreignObject
    // is flaky. Instead return bounding box and let Playwright clip — greenscreen isolates.
    const rect = planeNode.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, planeSelector);
  expect(sample).not.toBeNull();
  // Prefer element-host screenshots when measuring a known id is not required here;
  // full plane under greenscreen isolates paint without map texture.
  const png = Buffer.from(await plane.screenshot({ animations: "disabled" }));
  await plane.evaluate((node) => {
    const el = node as HTMLElement;
    el.style.backgroundImage = el.dataset.prevBgImage ?? "";
    el.style.backgroundColor = el.dataset.prevBgColor ?? "";
    delete el.dataset.prevBgImage;
    delete el.dataset.prevBgColor;
  });
  const meta = await sharp(png).metadata();
  const dprX = (meta.width ?? 1) / Math.max(1, planeBox!.width);
  const dprY = (meta.height ?? 1) / Math.max(1, planeBox!.height);
  return {
    png,
    originCss: { x: 0, y: 0 },
    dpr: (dprX + dprY) / 2,
    planeCss: { width: planeBox!.width, height: planeBox!.height },
  };
}

/**
 * Locate real painted element pixels by unique high-contrast color mask on an
 * isolated paint sample (elements layer / greenscreened published plane).
 */
async function measurePaintedBox(
  page: Page,
  color: { r: number; g: number; b: number },
  design: { width: number; height: number },
  label: string,
  mode: "editor" | "published",
): Promise<MeasuredBox> {
  const sample = await captureIsolatedPaintSample(page, mode);
  const mask = await locateColorMaskBounds(sample.png, color, 28);
  expect(mask, `${label}: painted pixels (${mode})`).not.toBeNull();
  const css = {
    x: sample.originCss.x + mask!.minX / sample.dpr,
    y: sample.originCss.y + mask!.minY / sample.dpr,
    width: (mask!.maxX - mask!.minX + 1) / sample.dpr,
    height: (mask!.maxY - mask!.minY + 1) / sample.dpr,
  };
  const scaleX = sample.planeCss.width / design.width;
  const scaleY = sample.planeCss.height / design.height;
  expect(scaleX).toBeGreaterThan(0);
  expect(scaleY).toBeGreaterThan(0);
  return {
    css,
    planeCss: sample.planeCss,
    design,
    scaleX,
    scaleY,
  };
}

/** Real stroke endpoints (left/right column centroids), not AABB vertical midpoints. */
async function measurePaintedArrowEndpoints(
  page: Page,
  color: { r: number; g: number; b: number },
  design: { width: number; height: number },
  label: string,
  mode: "editor" | "published",
): Promise<{
  start: { x: number; y: number };
  end: { x: number; y: number };
  box: MeasuredBox;
}> {
  const sample = await captureIsolatedPaintSample(page, mode);
  // SVG/Konva AA softens pure #FF0000; allow a wider channel window than solid rects.
  const ends = await locateColorStrokeEndpoints(sample.png, color, mode === "published" ? 64 : 40);
  expect(ends, `${label}: stroke endpoints (${mode})`).not.toBeNull();
  expect(ends!.end.x, `${label}: left-to-right orientation`).toBeGreaterThan(ends!.start.x);
  const scaleX = sample.planeCss.width / design.width;
  const scaleY = sample.planeCss.height / design.height;
  const box: MeasuredBox = {
    css: {
      x: sample.originCss.x + ends!.bounds.minX / sample.dpr,
      y: sample.originCss.y + ends!.bounds.minY / sample.dpr,
      width: (ends!.bounds.maxX - ends!.bounds.minX + 1) / sample.dpr,
      height: (ends!.bounds.maxY - ends!.bounds.minY + 1) / sample.dpr,
    },
    planeCss: sample.planeCss,
    design,
    scaleX,
    scaleY,
  };
  return {
    start: {
      x: sample.originCss.x + ends!.start.x / sample.dpr,
      y: sample.originCss.y + ends!.start.y / sample.dpr,
    },
    end: {
      x: sample.originCss.x + ends!.end.x / sample.dpr,
      y: sample.originCss.y + ends!.end.y / sample.dpr,
    },
    box,
  };
}

async function captureHighInfoPlaneCrop(
  page: Page,
  plane: "editor" | "published",
  design: { width: number; height: number },
  viewport: ViewportKind,
) {
  // Editor/published both use CSS CONTAIN background planes — clip in CSS px via page.screenshot.
  const planeLocator = plane === "editor"
    ? page.locator('[data-testid="portal-editor-background-plane"]')
    : page.locator('[data-testid="published-scene-plane"]');
  await expect(planeLocator).toBeVisible();
  await page.locator(".watermark-layer").evaluateAll((nodes) => {
    for (const node of nodes) (node as HTMLElement).style.visibility = "hidden";
  }).catch(() => undefined);
  if (plane === "editor") {
    await page.locator(".stageScroller, [class*='stageScroller']").first()
      .evaluate((node) => {
        (node as HTMLElement).scrollTop = 0;
        (node as HTMLElement).scrollLeft = 0;
      }).catch(() => undefined);
  }
  await planeLocator.scrollIntoViewIfNeeded();
  // Hide overlays so the crop is pure map paint (no text/shapes/Konva chrome).
  await page.evaluate(() => {
    document.querySelectorAll("[data-portal-element-id]").forEach((node) => {
      (node as HTMLElement).style.visibility = "hidden";
    });
    document.querySelectorAll('[aria-label="门户画布"] canvas').forEach((node) => {
      (node as HTMLElement).style.visibility = "hidden";
    });
  });
  await expect.poll(async () => {
    return planeLocator.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.backgroundImage !== "none" && style.backgroundImage.includes("url(");
    });
  }, { timeout: 15_000 }).toBe(true);

  const planeBox = await planeLocator.boundingBox();
  expect(planeBox).not.toBeNull();
  expect(planeBox!.width).toBeGreaterThan(design.width * 0.2);
  expect(planeBox!.height).toBeGreaterThan(design.height * 0.2);

  const crop = HIGH_INFO_CROP_DESIGN[viewport];
  const scaleX = planeBox!.width / design.width;
  const scaleY = planeBox!.height / design.height;
  const clip = {
    x: Math.max(0, Math.floor(planeBox!.x + crop.x * scaleX)),
    y: Math.max(0, Math.floor(planeBox!.y + crop.y * scaleY)),
    width: Math.max(1, Math.floor(crop.width * scaleX)),
    height: Math.max(1, Math.floor(crop.height * scaleY)),
  };
  const raw = Buffer.from(await page.screenshot({ animations: "disabled", clip }));
  // Normalize to design crop size so editor/published scale differences do not create
  // artificial nearest-neighbor mismatch in rgbaPixelDiffRatio.
  const png = await sharp(raw)
    .resize(crop.width, crop.height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const stats = await measureImageContentStats(png);
  assertHighInformationCrop(stats, `${plane}/${viewport} high-info crop`);
  return { png, clip };
}

async function withAuthContext(
  browser: Browser,
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>,
  options: { viewport: { width: number; height: number }; deviceScaleFactor: number },
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor,
  });
  try {
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await run(page);
  } finally {
    await context.close();
  }
}

test("administrator safely edits, publishes, isolates, previews, and restores city portals", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill("e2e-admin");
  await page.getByLabel("密码").fill("AdminE2EPass!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/guides");

  await expect(page.getByRole("heading", { name: "四城门户编辑器" })).toBeVisible();
  await expect(page.getByText("全城共用素材库")).toBeVisible();
  await uploadLogo(page);

  // Exercise the production pointer path, not only numeric inputs.
  const canvasElement = page.locator(".portal-canvas-element");
  const beforeDragX = Number(await page.getByLabel("X 坐标").inputValue());
  const beforeDragY = Number(await page.getByLabel("Y 坐标").inputValue());
  const elementBox = await canvasElement.boundingBox();
  expect(elementBox).not.toBeNull();
  await page.mouse.move(elementBox!.x + elementBox!.width / 2, elementBox!.y + elementBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(elementBox!.x + elementBox!.width / 2 + 30, elementBox!.y + elementBox!.height / 2 + 20);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.getByLabel("X 坐标").inputValue())).toBeGreaterThan(beforeDragX);
  await expect.poll(async () => Number(await page.getByLabel("Y 坐标").inputValue())).toBeGreaterThan(beforeDragY);

  const beforeWidth = Number(await page.getByLabel("宽度").inputValue());
  const beforeHeight = Number(await page.getByLabel("高度").inputValue());
  const resizeHandle = page.getByRole("button", { name: "右下调整大小" });
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 25, handleBox!.y + handleBox!.height / 2 + 15);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.getByLabel("宽度").inputValue())).toBeGreaterThan(beforeWidth);
  await expect.poll(async () => Number(await page.getByLabel("高度").inputValue())).toBeGreaterThan(beforeHeight);

  const versionOneDesktopX = Number(await page.getByLabel("X 坐标").inputValue());
  const versionOneDesktopWidth = Number(await page.getByLabel("宽度").inputValue());
  await page.getByRole("button", { name: "发布" }).click();
  await expect(page.getByText("当前画布未保存，无法发布，请先保存草稿")).toBeVisible();
  await page.getByRole("button", { name: "复制桌面到手机" }).click();
  await expect(page.getByText("当前桌面画布未保存，无法复制，请先保存草稿")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("tab", { name: "深圳" }).click();
  await expect(page.getByRole("tab", { name: "上海" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "员工预览" }).click();
  await expect(page.locator(".portal-viewer")).toBeVisible();
  await expect(page.getByLabel("预览（未发布）")).toBeVisible();
  await expect(page.locator(".portal-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "退出员工预览" }).click();
  await saveDraft(page);
  const persistedDesktop = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP");
    return response.json();
  });
  expect(persistedDesktop.draft.elements[0]).toMatchObject({ x: versionOneDesktopX, width: versionOneDesktopWidth });

  await page.getByRole("button", { name: "复制桌面到手机" }).click();
  await expect(page.getByText("已复制并约束到手机画布")).toBeVisible();

  // Saved drafts must remain invisible through the real employee browser path until publication.
  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/employee/guides/SHANGHAI");
  await expect(page.locator(".portal-viewer")).toHaveCount(0);
  await expect(page.locator(".portal-viewer img")).toHaveCount(0);
  await page.getByRole("button", { name: "切换到管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/guides");
  await publishBothViewports(page, "上海");
  await expect(page.getByText("上海门户版本 1 已发布")).toBeVisible();

  // A second city gets a different asset and publication without bleeding into Shanghai.
  await page.getByRole("tab", { name: "深圳" }).click();
  await page.getByRole("tab", { name: "桌面 1440×900" }).click();
  await uploadLogo(page);
  await saveDraft(page);
  await page.getByRole("button", { name: "复制桌面到手机" }).click();
  await expect(page.getByText("已复制并约束到手机画布")).toBeVisible();
  await publishBothViewports(page, "深圳");
  await expect(page.getByText("深圳门户版本 1 已发布")).toBeVisible();

  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/employee/guides/SHANGHAI");
  const shanghaiDesktopImage = page.locator(".portal-viewer img");
  await expect(shanghaiDesktopImage).toHaveCount(1);
  const shanghaiAssetUrl = await shanghaiDesktopImage.getAttribute("src");
  expect(shanghaiAssetUrl).toMatch(/^\/api\/files\//);
  const delivered = await page.evaluate(async (url) => {
    const response = await fetch(url!);
    return { status: response.status, contentType: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
  }, shanghaiAssetUrl);
  expect(delivered.status).toBe(200);
  expect(delivered.contentType).toBe("image/png");
  expect(delivered.bytes).toBeGreaterThan(0);

  const mobileResponse = page.waitForResponse((response) => response.url().includes("/api/portal/SHANGHAI?viewport=MOBILE") && response.status() === 200);
  await page.setViewportSize({ width: 390, height: 844 });
  await mobileResponse;
  await expect(page.locator(".portal-viewer")).toHaveAttribute("aria-label", "四城门户发布版本 1");
  await expect(page.locator(".portal-viewer img")).toHaveCount(1);

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/employee/guides/SHENZHEN");
  const shenzhenAssetUrl = await page.locator(".portal-viewer img").getAttribute("src");
  expect(shenzhenAssetUrl).toMatch(/^\/api\/files\//);
  expect(shenzhenAssetUrl).not.toBe(shanghaiAssetUrl);
  await page.goto("/employee/guides/SHANGHAI");
  await expect(page.locator(".portal-viewer img")).toHaveAttribute("src", shanghaiAssetUrl!);

  // Publish a second complete Shanghai version, then restore only desktop to version one.
  await page.getByRole("button", { name: "切换到管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/guides");
  await page.getByRole("tab", { name: "上海" }).click();
  await page.locator(".portal-canvas-element").click();
  await page.getByLabel("X 坐标").fill(String(versionOneDesktopX + 37));
  await saveDraft(page);
  await page.getByRole("tab", { name: "手机 390×844" }).click();
  await page.locator(".portal-canvas-element").click();
  const mobileX = Number(await page.getByLabel("X 坐标").inputValue());
  await page.getByLabel("X 坐标").fill(String(mobileX + 11));
  await saveDraft(page);
  await publishBothViewports(page, "上海");
  await expect(page.getByText("上海门户版本 2 已发布")).toBeVisible();
  await page.getByRole("tab", { name: "桌面 1440×900" }).click();
  await page.getByRole("button", { name: "恢复上一版本" }).click();
  await expect(page.getByText("上一发布版本已恢复为新草稿")).toBeVisible();
  await page.locator(".portal-canvas-element").click();
  await expect(page.getByLabel("X 坐标")).toHaveValue(String(versionOneDesktopX));
  await expect(page.getByLabel("宽度")).toHaveValue(String(versionOneDesktopWidth));
});

test("super admin, admin and employee role boundaries for the visual editor", async ({ page }) => {
  await login(page, "e2e-admin", "AdminE2EPass!23");
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP");
  await waitEditorReady(page);
  await assertNoAdminSidebar(page);
  await logout(page);

  await login(page, "E2E-ADMIN", "RegularAdmin!23");
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP");
  await waitEditorReady(page);
  await assertNoAdminSidebar(page);
  await logout(page);

  await login(page, "E2E-SEC", "EmployeeSecure!23");
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP");
  await expect(page).toHaveURL(/\/employee/);
  await expect(page.getByLabel("四城门户可视化编辑器")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存并发布" })).toHaveCount(0);
});

test("visual editor completes the four-city Task9 acceptance with screenshots and geometry parity", async ({ page, browser }) => {
  test.setTimeout(360_000);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const officeMapBytes = assertOfficeMapFixture();
  const officeMapMeta = await sharp(officeMapBytes).metadata();
  expect(officeMapMeta.width).toBe(1_014);
  expect(officeMapMeta.height).toBe(1_314);

  await login(page, "e2e-admin", "AdminE2EPass!23");
  await openShanghaiDesktopEditor(page);

  // Background: real office floor plan fixture + contain/cover exercise.
  await page.getByRole("button", { name: "页面设置" }).click();
  await expect(page.getByLabel("页面设置面板")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "正在加载素材" })).toBeHidden({
    timeout: 20_000,
  });
  await captureArtifact(page, "background-panel.png");
  await page.getByLabel("上传背景图片").setInputFiles({
    name: "office-map.png",
    mimeType: "image/png",
    buffer: officeMapBytes,
  });
  await expect(page.getByText(/office-map\.png 已上传/)).toBeVisible({ timeout: 20_000 });
  await page.getByText("铺满显示", { exact: true }).click();
  await expect(page.locator('input[name="background-fit"]').nth(1)).toBeChecked();
  await page.getByText("完整显示", { exact: true }).click();
  await expect(page.locator('input[name="background-fit"]').nth(0)).toBeChecked();
  // Office-map artifact after CONTAIN fit is confirmed (high-info region used later for pixel parity).
  await captureArtifact(page, "office-map.png");

  // Component panel + create text / rect / circle / line / arrow.
  await page.getByRole("button", { name: "添加组件" }).click();
  await expect(page.getByLabel("添加组件面板")).toBeVisible();
  await captureArtifact(page, "component-panel.png");

  for (const type of ["TEXT", "RECT", "CIRCLE", "LINE", "ARROW"] as const) {
    await page.locator(`[data-component-type="${type}"]`).click();
  }

  // Text: color / opacity / direct drag + real Transformer resize/rotate.
  await selectElementByLayer(page, "文字");
  await expect(page.getByLabel("文字内容")).toBeVisible();
  await page.getByLabel("文字内容").fill("上海前台接待");
  await page.getByLabel("图层名称").fill("前台文字");
  await page.getByLabel("文字颜色").fill("#0f766e");
  await page.getByLabel("透明度").fill("85");
  const textBefore = await readGeometry(page);
  await nudgeSelectedElement(page);
  await dragSelectedElement(page, 48, 32);
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBeGreaterThan(textBefore.x);
  await resizeSelectedViaTransformer(page);
  await rotateSelectedViaTransformer(page);
  // Reset rotation so later pixel geometry stays rotation=0 for the rect/arrow pair.
  await (await rotationField(page)).fill("0");
  await captureArtifact(page, "selected-text.png");

  // Shape: color / lock / visibility / layers + Transformer path.
  await selectElementByLayer(page, "矩形");
  await page.getByLabel("填充颜色").fill(GEOM_RECT_FILL);
  await page.getByLabel("描边颜色").fill("#9a3412");
  await page.getByRole("button", { name: "前移 矩形" }).click();
  await page.getByRole("button", { name: "隐藏 矩形" }).click();
  await page.getByRole("button", { name: "显示 矩形" }).click();
  await selectElementByLayer(page, "矩形");
  await page.getByRole("button", { name: "锁定 矩形" }).click();
  await expect(page.getByLabel("填充颜色")).toBeDisabled();
  await page.getByRole("button", { name: "解锁 矩形" }).click();
  await expect(page.getByLabel("填充颜色")).toBeEnabled();
  const shapeBefore = await readGeometry(page);
  await nudgeSelectedElement(page);
  await dragSelectedElement(page, 36, 24);
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBeGreaterThan(shapeBefore.x);
  await resizeSelectedViaTransformer(page);
  await captureArtifact(page, "selected-shape.png");

  // Circle / line / arrow: select + real Transformer rotate / keyboard path (not form-only).
  await selectElementByLayer(page, "圆形");
  await expect(page.getByLabel("选中元素控制框")).toBeVisible();
  await rotateSelectedViaTransformer(page);
  await (await rotationField(page)).fill("0");

  await selectElementByLayer(page, "线条");
  await page.getByLabel("线条颜色").fill("#1d4ed8");
  const lineBefore = await readGeometry(page);
  await nudgeSelectedElement(page, 16);
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBeGreaterThan(lineBefore.x);
  // Park line away from high-info crop / geometry targets.
  await writeGeometry(page, { x: 80, y: 820, w: 180, h: 10 });

  await selectElementByLayer(page, "箭头");
  await page.getByLabel("线条颜色").fill(GEOM_ARROW_STROKE);
  await page.getByLabel("线宽").fill("16");
  const arrowBefore = await readGeometry(page);
  await nudgeSelectedElement(page, 16);
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBeGreaterThan(arrowBefore.x);

  // Deterministic high-contrast geometry targets (rotation=0) for visual pixel parity.
  // Keep ALL elements off the high-info map crop windows (DESKTOP 720,380 80×80 / MOBILE 155,360 72×72).
  await selectElementByLayer(page, "前台文字");
  await writeGeometry(page, { x: 40, y: 40, w: 220, h: 48 });
  await (await rotationField(page)).fill("0");
  await selectElementByLayer(page, "圆形");
  await writeGeometry(page, { x: 40, y: 120, w: 90, h: 90 });
  await selectElementByLayer(page, "箭头");
  // Slight diagonal so real stroke endpoints differ in Y (not collapsed AABB midY).
  await writeGeometry(page, { x: 480, y: 720, w: 280, h: 40 });
  await (await rotationField(page)).fill("0");
  await selectElementByLayer(page, "矩形");
  await page.getByLabel("填充颜色").fill(GEOM_RECT_FILL);
  await writeGeometry(page, { x: 480, y: 60, w: 160, h: 100 });
  await (await rotationField(page)).fill("0");
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("480");

  // Extreme-zoom adjustment overlay: 6 buttons unclipped, focusable, clickable (real DOM).
  await assertAdjustmentOverlayUsableAtZoom(page, 10);
  await setEditorZoomTo100Percent(page);
  // Re-assert deterministic rect geometry after zoom/overlay interaction.
  await selectElementByLayer(page, "矩形");
  await writeGeometry(page, { x: 480, y: 60, w: 160, h: 100 });
  await (await rotationField(page)).fill("0");

  // Real undo / redo on canvas geometry.
  const undoBaseline = await readGeometry(page);
  await dragSelectedElement(page, 40, 20);
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBeGreaterThan(undoBaseline.x);
  const afterDrag = await readGeometry(page);
  await page.getByRole("button", { name: "撤销" }).click();
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBe(undoBaseline.x);
  await page.getByRole("button", { name: "重做" }).click();
  await expect.poll(async () => (await readGeometry(page)).x, { timeout: 10_000 })
    .toBe(afterDrag.x);
  // Return to deterministic geometry for publish/parity.
  await writeGeometry(page, { x: 480, y: 60, w: 160, h: 100 });
  await (await rotationField(page)).fill("0");

  await saveVisualDraft(page);
  const savedDesktop = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP");
    return response.json();
  }) as {
    draft: {
      scene: {
        elements: Array<{
          type: string;
          x: number;
          y: number;
          width: number;
          height: number;
          rotation?: number;
          fill?: string;
          stroke?: string;
        }>;
      };
    };
  };
  const savedArrow = savedDesktop.draft.scene.elements.find((element) => element.type === "ARROW");
  const savedRect = savedDesktop.draft.scene.elements.find((element) => element.type === "RECT");
  expect(savedArrow).toMatchObject({ x: 480, y: 720, width: 280, height: 40, rotation: 0 });
  expect(savedRect).toMatchObject({ x: 480, y: 60, width: 160, height: 100, rotation: 0 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitEditorReady(page);
  await selectElementByLayer(page, "前台文字");
  await expect(page.getByLabel("文字内容")).toHaveValue("上海前台接待");

  await page.getByRole("button", { name: "预览", exact: true }).click();
  const previewDialog = page.getByRole("dialog", { name: "员工预览" });
  await expect(previewDialog).toBeVisible();
  await expect(page.getByText("预览（未发布）")).toBeVisible();
  await previewDialog.getByRole("button", { name: "退出预览" }).click();
  await expect(previewDialog).toHaveCount(0);

  await captureArtifact(page, "pc-editor.png");

  // Copy desktop → mobile, then independent mobile edit + save, then publish.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "复制桌面到手机" }).click();
  await expect(page.getByText(/已复制并约束到手机画布/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "手机", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "适应窗口" }).click();
  await selectElementByLayer(page, "前台文字");
  await page.getByLabel("文字内容").fill("上海前台接待 · 手机");
  await dragSelectedElement(page, 16, 12);
  await saveVisualDraft(page);
  await captureArtifact(page, "mobile-editor.png");

  // Publish after mobile review + independent save.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("手机版需要人工审查")).toBeVisible();
  await page.getByRole("button", { name: "已检查手机版，继续发布" }).click();
  await expect(page.getByText(/上海门户版本 \d+ 已发布/)).toBeVisible({ timeout: 30_000 });

  // Resolve stable element ids from the authoritative desktop draft scene.
  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  const desktopDraft = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP");
    return response.json();
  }) as {
    draft: {
      scene: {
        elements: Array<{ id: string; type: string; name: string }>;
      };
    };
  };
  const arrowId = desktopDraft.draft.scene.elements.find((element) => element.type === "ARROW")?.id;
  const rectId = desktopDraft.draft.scene.elements.find((element) => element.type === "RECT")?.id;
  expect(arrowId, "arrow element id").toBeTruthy();
  expect(rectId, "rect element id").toBeTruthy();

  // Mobile ids come from the copied mobile draft (ids preserved by copy).
  const mobileDraft = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=MOBILE");
    return response.json();
  }) as {
    draft: {
      scene: {
        elements: Array<{ id: string; type: string }>;
      };
    };
  };
  const mobileArrowId = mobileDraft.draft.scene.elements.find((element) => element.type === "ARROW")?.id;
  const mobileRectId = mobileDraft.draft.scene.elements.find((element) => element.type === "RECT")?.id;
  expect(mobileArrowId).toBe(arrowId);
  expect(mobileRectId).toBe(rectId);

  // Keep the admin session on the primary page. Employee views use a separate
  // authenticated browser context so cookie/session state is not invalidated.
  const adminCookies = await page.context().cookies();
  let employeeCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
  await withAuthContext(browser, [], {
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  }, async (employeePage) => {
    await login(employeePage, "E2E-SEC", "EmployeeSecure!23");
    await expect(employeePage).toHaveURL(/\/employee/);
    await employeePage.goto("/employee/guides/SHANGHAI", { waitUntil: "domcontentloaded" });
    await expect(employeePage.getByLabel(/四城门户发布版本/)).toBeVisible({ timeout: 20_000 });
    await assertNoEmployeeEditControls(employeePage);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    await employeePage.screenshot({
      path: path.join(ARTIFACT_DIR, "employee-pc.png"),
      fullPage: true,
      animations: "disabled",
    });
    expect(statSync(path.join(ARTIFACT_DIR, "employee-pc.png")).size).toBeGreaterThan(8_000);

    await employeePage.setViewportSize({ width: 390, height: 844 });
    await expect(employeePage.getByLabel(/四城门户发布版本/)).toBeVisible({ timeout: 20_000 });
    await assertNoEmployeeEditControls(employeePage);
    await employeePage.screenshot({
      path: path.join(ARTIFACT_DIR, "employee-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    expect(statSync(path.join(ARTIFACT_DIR, "employee-mobile.png")).size).toBeGreaterThan(8_000);
    employeeCookies = await employeePage.context().cookies();
  });
  expect(employeeCookies.length).toBeGreaterThan(0);

  // 4-combo geometry + real pixel parity: DESKTOP|MOBILE × DPR1|DPR2.
  // Editor: Konva paint mask. Published: visible element wrapper. Dual-scale ≤1 CSS px.
  // High-info synthetic-map crop (not letterbox) sharp pixel-diff < 1%.
  const matrix: Array<{
    viewport: ViewportKind;
    dpr: 1 | 2;
    editorViewport: { width: number; height: number };
    publishedViewport: { width: number; height: number };
  }> = [
    {
      viewport: "DESKTOP",
      dpr: 1,
      editorViewport: { width: 1_900, height: 1_200 },
      publishedViewport: { width: 1_600, height: 1_100 },
    },
    {
      viewport: "DESKTOP",
      dpr: 2,
      editorViewport: { width: 1_900, height: 1_200 },
      publishedViewport: { width: 1_600, height: 1_100 },
    },
    {
      viewport: "MOBILE",
      dpr: 1,
      editorViewport: { width: 1_400, height: 1_100 },
      // Wide enough that publishedScale stays 1 (min(1, container/390)) for map crop parity.
      publishedViewport: { width: 430, height: 900 },
    },
    {
      viewport: "MOBILE",
      dpr: 2,
      editorViewport: { width: 1_400, height: 1_100 },
      publishedViewport: { width: 430, height: 900 },
    },
  ];

  for (const cell of matrix) {
    const design = DESIGN[cell.viewport];
    let editorArrow!: MeasuredBox;
    let editorRect!: MeasuredBox;
    let editorCrop!: Buffer;
    let publishedArrow!: MeasuredBox;
    let publishedRect!: MeasuredBox;
    let publishedCrop!: Buffer;
    let editorArrowEnds!: { start: { x: number; y: number }; end: { x: number; y: number } };
    let publishedArrowEnds!: { start: { x: number; y: number }; end: { x: number; y: number } };
    const cropDesign = HIGH_INFO_CROP_DESIGN[cell.viewport];

    await withAuthContext(browser, employeeCookies, {
      viewport: cell.publishedViewport,
      deviceScaleFactor: cell.dpr,
    }, async (publishedPage) => {
      await publishedPage.goto("/employee/guides/SHANGHAI", { waitUntil: "domcontentloaded" });
      await expect(publishedPage.getByLabel(/四城门户发布版本/)).toBeVisible({ timeout: 20_000 });
      await expect.poll(async () => {
        return publishedPage.locator('[data-testid="published-scene-plane"]').evaluate((node) =>
          node.getBoundingClientRect().width);
      }).toBeGreaterThan(100);
      await expect(publishedPage.locator(`[data-portal-element-id="${arrowId}"]`).first()).toBeVisible();
      await expect(publishedPage.locator(`[data-portal-element-id="${rectId}"]`).first()).toBeVisible();
      // Individual rect paint (greenscreened plane, no map background).
      publishedRect = await measurePaintedBox(
        publishedPage,
        GEOM_RECT_RGB,
        design,
        `${cell.viewport}/DPR${cell.dpr} published rect`,
        "published",
      );
      // Individual arrow stroke endpoints (not AABB midY collapse).
      const pArrow = await measurePaintedArrowEndpoints(
        publishedPage,
        GEOM_ARROW_RGB,
        design,
        `${cell.viewport}/DPR${cell.dpr} published arrow`,
        "published",
      );
      publishedArrow = pArrow.box;
      publishedArrowEnds = { start: pArrow.start, end: pArrow.end };
      publishedCrop = (await captureHighInfoPlaneCrop(
        publishedPage,
        "published",
        design,
        cell.viewport,
      )).png;
    });

    await withAuthContext(browser, adminCookies, {
      viewport: cell.editorViewport,
      deviceScaleFactor: cell.dpr,
    }, async (editorPage) => {
      await editorPage.goto(
        `/admin/guides/editor?city=SHANGHAI&viewport=${cell.viewport}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(editorPage.getByLabel("四城门户可视化编辑器")).toBeVisible({ timeout: 30_000 });
      await expect(editorPage.getByText(/草稿已加载|草稿已保存|已发布|已恢复/)).toBeVisible({
        timeout: 30_000,
      });
      if (cell.viewport === "MOBILE") {
        await editorPage.getByRole("button", { name: "手机", exact: true }).click();
        await expect(editorPage.getByRole("button", { name: "手机", exact: true }))
          .toHaveAttribute("aria-pressed", "true");
        await expect(editorPage.getByText(/草稿已加载|草稿已保存/)).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(editorPage.getByRole("button", { name: "桌面", exact: true }))
          .toHaveAttribute("aria-pressed", "true");
      }
      await setEditorZoomTo100Percent(editorPage);
      // Guard: design plane must match the matrix viewport (avoids DESKTOP map cropped with MOBILE coords).
      const designPlaneBox = await editorPage.locator('[data-testid="portal-design-plane"]').boundingBox();
      expect(designPlaneBox, "design plane box").not.toBeNull();
      expect(
        Math.abs(designPlaneBox!.width - design.width),
        `${cell.viewport} design plane width at 100% zoom`,
      ).toBeLessThan(3);
      expect(
        Math.abs(designPlaneBox!.height - design.height),
        `${cell.viewport} design plane height at 100% zoom`,
      ).toBeLessThan(3);
      await expect(editorPage.locator(`[data-portal-element-id="${arrowId}"]`).first()).toBeVisible();
      await expect(editorPage.locator(`[data-portal-element-id="${rectId}"]`).first()).toBeVisible();
      // Deselect so Transformer handles do not pollute elements-layer paint.
      await editorPage.mouse.click(12, 12);
      // Elements-layer toDataURL (not page-composited canvas.first hit slab).
      editorRect = await measurePaintedBox(
        editorPage,
        GEOM_RECT_RGB,
        design,
        `${cell.viewport}/DPR${cell.dpr} editor rect`,
        "editor",
      );
      const eArrow = await measurePaintedArrowEndpoints(
        editorPage,
        GEOM_ARROW_RGB,
        design,
        `${cell.viewport}/DPR${cell.dpr} editor arrow`,
        "editor",
      );
      editorArrow = eArrow.box;
      editorArrowEnds = { start: eArrow.start, end: eArrow.end };
      editorCrop = (await captureHighInfoPlaneCrop(
        editorPage,
        "editor",
        design,
        cell.viewport,
      )).png;
    });

    // Painted geometry → design recovery → both CSS scales ≤1 px.
    const toDesign = (box: MeasuredBox): DesignBox => ({
      x: box.css.x / box.scaleX,
      y: box.css.y / box.scaleY,
      width: box.css.width / box.scaleX,
      height: box.css.height / box.scaleY,
    });
    const toDesignPoint = (
      point: { x: number; y: number },
      box: MeasuredBox,
    ) => ({
      x: point.x / box.scaleX,
      y: point.y / box.scaleY,
    });
    const eRectDesign = toDesign(editorRect);
    const pRectDesign = toDesign(publishedRect);
    const eEnds = {
      start: toDesignPoint(editorArrowEnds.start, editorArrow),
      end: toDesignPoint(editorArrowEnds.end, editorArrow),
    };
    const pEnds = {
      start: toDesignPoint(publishedArrowEnds.start, publishedArrow),
      end: toDesignPoint(publishedArrowEnds.end, publishedArrow),
    };
    // Orientation: real down-right diagonal (280×40 design), not just L→R or AABB midY collapse.
    // Minimum design-Y delta must be meaningful vs stroke thickness (~16 CSS) after dual-scale recovery.
    const minDiagonalDesignY = 8;
    expect(eEnds.end.x, `${cell.viewport}/DPR${cell.dpr} editor arrow L→R`).toBeGreaterThan(eEnds.start.x);
    expect(pEnds.end.x, `${cell.viewport}/DPR${cell.dpr} published arrow L→R`).toBeGreaterThan(pEnds.start.x);
    expect(
      eEnds.end.y - eEnds.start.y,
      `${cell.viewport}/DPR${cell.dpr} editor arrow down-right Δy (eStart=${eEnds.start.y}, eEnd=${eEnds.end.y})`,
    ).toBeGreaterThan(minDiagonalDesignY);
    expect(
      pEnds.end.y - pEnds.start.y,
      `${cell.viewport}/DPR${cell.dpr} published arrow down-right Δy (pStart=${pEnds.start.y}, pEnd=${pEnds.end.y})`,
    ).toBeGreaterThan(minDiagonalDesignY);
    const assertBothScalesWithinOneCssPx = (
      editorDesign: number,
      publishedDesign: number,
      editorScale: number,
      publishedScale: number,
      label: string,
    ) => {
      const designDelta = Math.abs(editorDesign - publishedDesign);
      const editorCssError = designDelta * editorScale;
      const publishedCssError = designDelta * publishedScale;
      expect(
        editorCssError,
        `${label} editorScale (eDesign=${editorDesign}, pDesign=${publishedDesign}, eScale=${editorScale}, pScale=${publishedScale}, editorCssError=${editorCssError}, publishedCssError=${publishedCssError})`,
      ).toBeLessThanOrEqual(1);
      expect(
        publishedCssError,
        `${label} publishedScale (eDesign=${editorDesign}, pDesign=${publishedDesign}, eScale=${editorScale}, pScale=${publishedScale}, editorCssError=${editorCssError}, publishedCssError=${publishedCssError})`,
      ).toBeLessThanOrEqual(1);
    };

    // Rect solid fill edges (individual color mask).
    assertBothScalesWithinOneCssPx(
      eRectDesign.x, pRectDesign.x, editorRect.scaleX, publishedRect.scaleX,
      `${cell.viewport}/DPR${cell.dpr} rect.left`,
    );
    assertBothScalesWithinOneCssPx(
      eRectDesign.y, pRectDesign.y, editorRect.scaleY, publishedRect.scaleY,
      `${cell.viewport}/DPR${cell.dpr} rect.top`,
    );
    assertBothScalesWithinOneCssPx(
      eRectDesign.x + eRectDesign.width, pRectDesign.x + pRectDesign.width,
      editorRect.scaleX, publishedRect.scaleX,
      `${cell.viewport}/DPR${cell.dpr} rect.right`,
    );
    assertBothScalesWithinOneCssPx(
      eRectDesign.y + eRectDesign.height, pRectDesign.y + pRectDesign.height,
      editorRect.scaleY, publishedRect.scaleY,
      `${cell.viewport}/DPR${cell.dpr} rect.bottom`,
    );

    // Arrow real stroke endpoints (column centroids).
    assertBothScalesWithinOneCssPx(
      eEnds.start.x, pEnds.start.x, editorArrow.scaleX, publishedArrow.scaleX,
      `${cell.viewport}/DPR${cell.dpr} arrow start.x`,
    );
    assertBothScalesWithinOneCssPx(
      eEnds.start.y, pEnds.start.y, editorArrow.scaleY, publishedArrow.scaleY,
      `${cell.viewport}/DPR${cell.dpr} arrow start.y`,
    );
    assertBothScalesWithinOneCssPx(
      eEnds.end.x, pEnds.end.x, editorArrow.scaleX, publishedArrow.scaleX,
      `${cell.viewport}/DPR${cell.dpr} arrow end.x`,
    );
    assertBothScalesWithinOneCssPx(
      eEnds.end.y, pEnds.end.y, editorArrow.scaleY, publishedArrow.scaleY,
      `${cell.viewport}/DPR${cell.dpr} arrow end.y`,
    );

    // Pure CSS CONTAIN backgrounds (elements/Konva hidden). Same paint model; channelTolerance
    // only absorbs subpixel CSS background resampling (measured ~3% at tol=0 on mobile scale=1).
    // Ratio gate stays hard at <1%.
    const pixelRatio = await rgbaPixelDiffRatio(editorCrop, publishedCrop, {
      width: cropDesign.width,
      height: cropDesign.height,
      channelTolerance: 8,
    });
    expect(
      pixelRatio,
      `${cell.viewport}/DPR${cell.dpr} high-info map pixel ratio (threshold ${PIXEL_DIFF_LIMIT})`,
    ).toBeLessThan(PIXEL_DIFF_LIMIT);
  }

  // History restore + second publish path (primary admin session still valid).
  await page.goto("/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP", {
    waitUntil: "domcontentloaded",
  });
  await waitEditorReady(page);
  await selectElementByLayer(page, "前台文字");
  await page.getByLabel("文字内容").fill("上海前台接待 · v2");
  await saveVisualDraft(page);
  await page.getByRole("button", { name: "手机", exact: true }).click();
  await waitEditorReady(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "保存并发布" }).click();
  // Mobile may already be reviewed from previous publish pair path.
  const reviewNeeded = page.getByText("手机版需要人工审查");
  if (await reviewNeeded.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "已检查手机版，继续发布" }).click();
  }
  await expect(page.getByText(/上海门户版本 \d+ 已发布/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "桌面", exact: true }).click();
  await waitEditorReady(page);
  await page.getByRole("button", { name: "历史" }).click();
  await expect(page.getByRole("dialog", { name: "发布历史" })).toBeVisible();
  const restoreButtons = page.getByRole("button", { name: /恢复版本/ });
  await expect(restoreButtons.first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await restoreButtons.last().click();
  await expect(page.getByText(/已恢复为新草稿/)).toBeVisible({ timeout: 20_000 });

  // Unaffected navigation smoke.
  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "入职学习看板" })).toBeVisible();
  await page.goto("/admin/employees", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /员工/ })).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/employee(\/|$)/),
    page.getByRole("button", { name: "切换到员工端" }).click(),
  ]);
  await expect(page.getByRole("link", { name: /指南/ }).first()).toBeVisible({ timeout: 15_000 });
  await page.goto("/employee/guides", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/employee\/guides/);
  await expect(page.getByRole("heading", { name: /四地入职指南/ })).toBeVisible({ timeout: 15_000 });

  // Final artifact integrity.
  for (const name of REQUIRED_SCREENSHOTS) {
    const stats = statSync(path.join(ARTIFACT_DIR, name));
    expect(stats.size, `${name} must be a real non-blank screenshot`).toBeGreaterThan(8_000);
  }
});

test("long-map editor fixes persist through upload, drawing, copy, publish, and mobile viewing", async ({ page }) => {
  test.setTimeout(180_000);
  const artifactDir = path.join(process.cwd(), "artifacts", "portal-editor-fixes");
  mkdirSync(artifactDir, { recursive: true });
  const realLongMapPath = process.env.PORTAL_LONG_IMAGE;
  const longMap = realLongMapPath
    ? readFileSync(realLongMapPath)
    : await sharp({
      create: {
        width: 522,
        height: 2_048,
        channels: 4,
        background: { r: 214, g: 242, b: 225, alpha: 1 },
      },
    }).png().toBuffer();
  const longMapMeta = await sharp(longMap).metadata();
  expect(longMapMeta.width).toBeTruthy();
  expect(longMapMeta.height! / longMapMeta.width!).toBeGreaterThan(3);
  const componentImage = await sharp({
    create: {
      width: 640,
      height: 360,
      channels: 4,
      background: { r: 20, g: 184, b: 166, alpha: 1 },
    },
  }).png().toBuffer();
  const screenshot = async (name: string, fullPage = false) => {
    const target = path.join(artifactDir, name);
    await page.screenshot({ path: target, fullPage, animations: "disabled" });
    expect(statSync(target).size, `${name} should contain a real screenshot`).toBeGreaterThan(8_000);
  };

  await login(page, "e2e-admin", "AdminE2EPass!23");
  await openShanghaiDesktopEditor(page);
  await expect(page.getByText("请求未能完成，请稍后重试")).toHaveCount(0);

  await page.getByRole("button", { name: "页面设置" }).click();
  await page.getByLabel("上传背景图片").setInputFiles({
    name: realLongMapPath ? path.basename(realLongMapPath) : "long-office-map.png",
    mimeType: "image/png",
    buffer: longMap,
  });
  await expect(page.getByText(/已上传/)).toBeVisible({ timeout: 30_000 });
  await page.getByText("长图完整显示（高度自适应）", { exact: true }).click();
  await expect(page.locator('input[name="background-fit"]').nth(2)).toBeChecked();
  await expect(page.getByLabel("背景 X 位置")).toBeDisabled();
  await expect(page.getByLabel("背景 Y 位置")).toBeDisabled();

  const expectedDesktopHeight = 1_440 * longMapMeta.height! / longMapMeta.width!;
  await expect.poll(async () => page.getByText(/上海门户/).first().locator("xpath=following-sibling::span").textContent())
    .toContain(String(Math.round(expectedDesktopHeight)));
  const desktopPlane = page.getByTestId("portal-design-plane");
  await expect(desktopPlane).toBeVisible();
  const desktopSize = await desktopPlane.evaluate((node) => ({
    width: (node as HTMLElement).offsetWidth,
    height: (node as HTMLElement).offsetHeight,
  }));
  expect(desktopSize.height / desktopSize.width).toBeCloseTo(longMapMeta.height! / longMapMeta.width!, 2);

  await page.getByRole("button", { name: "添加组件" }).click();
  const scroller = page.locator("[class*='stageScroller']").first();
  await scroller.evaluate((node) => {
    (node as HTMLElement).scrollTop = Math.min(900, (node as HTMLElement).scrollHeight / 3);
  });
  const zoom = (await readZoomPercent(page)) / 100;
  const visibleCenterBeforeUpload = await page.evaluate((currentZoom) => {
    const scrollNode = document.querySelector("[class*='stageScroller']");
    const canvasNode = document.querySelector('[data-testid="portal-design-plane"]');
    if (!(scrollNode instanceof HTMLElement) || !(canvasNode instanceof HTMLElement)) return null;
    const scrollRect = scrollNode.getBoundingClientRect();
    const canvasRect = canvasNode.getBoundingClientRect();
    const visibleTop = Math.max(scrollRect.top, canvasRect.top);
    const visibleBottom = Math.min(scrollRect.bottom, canvasRect.bottom);
    return ((visibleTop + visibleBottom) / 2 - canvasRect.top) / currentZoom;
  }, zoom);
  expect(visibleCenterBeforeUpload).not.toBeNull();

  await page.getByLabel("上传本地图片并添加到画布").setInputFiles({
    name: "uploaded-card.png",
    mimeType: "image/png",
    buffer: componentImage,
  });
  await expect(page.getByText(/uploaded-card\.png 已上传并添加到画布/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("锁定宽高比")).toBeChecked();
  await expect(page.getByLabel("选中元素控制框")).toHaveAttribute(
    "data-resize-anchors",
    /top-left.*top-center.*top-right.*middle-left.*middle-right.*bottom-left.*bottom-center.*bottom-right/,
  );
  const uploadedGeometry = await readGeometry(page);
  expect(uploadedGeometry.y + uploadedGeometry.h / 2).toBeCloseTo(visibleCenterBeforeUpload!, -1);
  await screenshot("upload-image-component.png");

  await page.getByRole("button", { name: "添加组件" }).click();
  await page.locator('[data-component-type="FREEHAND"]').click();
  await expect(page.getByTestId("portal-editor-stage-host")).toHaveAttribute("data-draw-tool", "FREEHAND");
  const scrollerBox = await scroller.boundingBox();
  expect(scrollerBox).not.toBeNull();
  const start = { x: scrollerBox!.x + scrollerBox!.width * 0.45, y: scrollerBox!.y + scrollerBox!.height * 0.35 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 50, start.y + 45, { steps: 8 });
  await page.mouse.move(start.x + 110, start.y - 20, { steps: 8 });
  await page.mouse.move(start.x + 165, start.y + 35, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("自由路径已创建并选中")).toBeVisible();
  await expect(page.getByTestId("portal-editor-stage-host")).not.toHaveAttribute("data-draw-tool", "FREEHAND");
  await expect(page.getByText("自由画笔", { exact: true })).toBeVisible();
  await page.getByLabel("线条颜色").fill("#E11D48");
  await page.getByLabel("线宽").fill("9");
  await page.getByLabel("平滑度").fill("0.65");
  await screenshot("freehand-component.png");

  for (const type of ["RECT", "CIRCLE", "TRIANGLE"] as const) {
    await page.getByRole("button", { name: "添加组件" }).click();
    await page.locator(`[data-component-type="${type}"]`).click();
    await page.getByLabel("描边颜色").fill("#2563EB");
    await page.getByRole("button", { name: "无填充" }).click();
    await expect(page.getByRole("status", { name: "无填充" })).toBeVisible();
  }
  await screenshot("no-fill-shapes.png");
  await screenshot("desktop-editor-long-map.png");

  await saveVisualDraft(page);
  const desktopDraft = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP");
    return response.json();
  }) as { draft: { scene: PortalSceneV1 } };
  expect(desktopDraft.draft.scene.background).toMatchObject({
    fitMode: "AUTO_HEIGHT",
    naturalWidth: longMapMeta.width,
    naturalHeight: longMapMeta.height,
  });
  expect(desktopDraft.draft.scene.canvas?.logicalHeight).toBeCloseTo(expectedDesktopHeight, 3);
  expect(desktopDraft.draft.scene.elements.some((element) => element.type === "IMAGE")).toBe(true);
  expect(desktopDraft.draft.scene.elements.some((element) => element.type === "FREEHAND")).toBe(true);
  expect(desktopDraft.draft.scene.elements.filter((element) =>
    ["RECT", "CIRCLE", "TRIANGLE"].includes(element.type)
    && "fillEnabled" in element
    && element.fillEnabled === false)).toHaveLength(3);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitEditorReady(page);
  await expect(page.getByText("请求未能完成，请稍后重试")).toHaveCount(0);
  await page.getByRole("button", { name: "图层" }).click();
  await expect(page.getByRole("button", { name: "选择 自由绘制", exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "复制桌面到手机" }).click();
  await expect(page.getByText(/已复制并约束到手机画布/)).toBeVisible({ timeout: 30_000 });
  const mobileDraft = await page.evaluate(async () => {
    const response = await fetch("/api/admin/portal/SHANGHAI/draft?viewport=MOBILE");
    return response.json();
  }) as { draft: { scene: PortalSceneV1 } };
  expect(mobileDraft.draft.scene.background.fitMode).toBe("AUTO_HEIGHT");
  expect(mobileDraft.draft.scene.canvas?.logicalHeight).toBeCloseTo(
    390 * longMapMeta.height! / longMapMeta.width!,
    3,
  );
  const desktopFreehand = desktopDraft.draft.scene.elements.find((element) => element.type === "FREEHAND");
  const mobileFreehand = mobileDraft.draft.scene.elements.find((element) => element.type === "FREEHAND");
  expect(desktopFreehand?.type).toBe("FREEHAND");
  expect(mobileFreehand?.type).toBe("FREEHAND");
  if (desktopFreehand?.type === "FREEHAND" && mobileFreehand?.type === "FREEHAND") {
    expect(mobileFreehand.points[2]).toBeCloseTo(desktopFreehand.points[2]! * 390 / 1_440, 3);
    expect(mobileFreehand.strokeWidth).toBeCloseTo(desktopFreehand.strokeWidth * 390 / 1_440, 3);
  }
  await screenshot("mobile-editor-long-map.png");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "保存并发布" }).click();
  const reviewNeeded = page.getByText("手机版需要人工审查");
  await expect(reviewNeeded.or(page.getByText(/上海门户版本 \d+ 已发布/))).toBeVisible({ timeout: 30_000 });
  if (await reviewNeeded.isVisible()) {
    await page.getByRole("button", { name: "已检查手机版，继续发布" }).click();
  }
  await expect(page.getByText(/上海门户版本 \d+ 已发布/)).toBeVisible({ timeout: 30_000 });

  await logout(page);
  await login(page, "E2E-SEC", "EmployeeSecure!23");
  await page.setViewportSize({ width: 1_440, height: 960 });
  await page.goto("/employee/guides/SHANGHAI", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel(/四城门户发布版本/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-portal-element-type="FREEHAND"]')).toBeVisible();
  await expect(page.locator('[data-portal-element-type="IMAGE"]').first()).toBeVisible();
  await assertNoEmployeeEditControls(page);
  const publishedDesktopPlane = page.getByTestId("published-scene-plane");
  const publishedDesktopSize = await publishedDesktopPlane.evaluate((node) => ({
    width: (node as HTMLElement).offsetWidth,
    height: (node as HTMLElement).offsetHeight,
  }));
  expect(publishedDesktopSize.height / publishedDesktopSize.width)
    .toBeCloseTo(longMapMeta.height! / longMapMeta.width!, 2);
  await screenshot("employee-pc-long-map.png", true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel(/四城门户发布版本/)).toBeVisible({ timeout: 30_000 });
  const publishedMobileSize = await publishedDesktopPlane.evaluate((node) => ({
    width: (node as HTMLElement).offsetWidth,
    height: (node as HTMLElement).offsetHeight,
  }));
  expect(publishedMobileSize.height / publishedMobileSize.width)
    .toBeCloseTo(longMapMeta.height! / longMapMeta.width!, 2);
  await screenshot("employee-mobile-long-map.png", true);
});
