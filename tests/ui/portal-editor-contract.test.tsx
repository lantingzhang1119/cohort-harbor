// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalCanvas } from "@/features/portal/components/portal-canvas";
import { PortalEditor } from "@/features/portal/components/portal-editor";

type Element = { id: string; kind: "IMAGE"; assetId: string; assetUrl: string; x: number; y: number; width: number; height: number; zIndex: number; altText: string };
const element = (id = "hero", assetId = "asset-1", altText = "办公环境"): Element => ({ id, kind: "IMAGE", assetId, assetUrl: `/api/files/${assetId}`, x: 10, y: 20, width: 240, height: 120, zIndex: 1, altText });
const assets = [
  { id: "asset-1", originalName: "hero.png", mimeType: "image/png", sizeBytes: 100, url: "/api/files/asset-1" },
  { id: "asset-2", originalName: "replacement.png", mimeType: "image/png", sizeBytes: 100, url: "/api/files/asset-2" },
];

function installFetch(options: { failCity?: string; upload?: Promise<Response>; save?: Promise<Response>; restore?: Promise<Response>; draftElements?: Element[] } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (options.failCity && url.includes(`/portal/${options.failCity}/draft`)) return Response.json({ ok: false, message: "加载失败" }, { status: 500 });
    if (url.endsWith("/assets") && method === "GET") return Response.json({ ok: true, assets });
    if (url.endsWith("/assets") && method === "POST" && options.upload) return options.upload;
    if (url.includes("/draft?") && method === "GET") {
      const city = url.match(/portal\/([^/]+)\/draft/)?.[1] ?? "SHANGHAI";
      const id = city === "SHENZHEN" ? "shenzhen" : "hero";
      return Response.json({ ok: true, draft: { elements: options.draftElements ?? [element(id)] } });
    }
    if (url.endsWith("/draft") && method === "PATCH") {
      if (options.save) return options.save;
      const body = JSON.parse(String(init?.body)) as { elements: Element[] };
      return Response.json({ ok: true, draft: { elements: body.elements.map((item) => ({ ...item, assetUrl: `/api/files/${item.assetId}` })) } });
    }
    if (url.endsWith("/draft") && method === "POST") return Response.json({ ok: true, draft: { elements: [element("mobile")] } });
    if (url.endsWith("/publish")) return Response.json({ ok: true, version: 2 }, { status: 201 });
    if (url.endsWith("/restore")) return options.restore ?? Response.json({ ok: true, draft: { elements: [element("restored")] } });
    if (url.includes("/assets?assetId=") && method === "DELETE") return Response.json({ ok: true });
    throw new Error(`Unhandled fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function renderLoaded(options?: Parameters<typeof installFetch>[0]) {
  const harness = installFetch(options);
  render(<PortalEditor />);
  await screen.findByRole("img", { name: "办公环境" });
  return harness;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("portal editor contract", () => {
  it("keeps the immersive editor authenticated and outside the normal AppShell", () => {
    const layout = readFileSync(
      join(process.cwd(), "src/app/(portal-editor)/layout.tsx"),
      "utf8",
    );
    const page = readFileSync(
      join(process.cwd(), "src/app/(portal-editor)/admin/guides/editor/page.tsx"),
      "utf8",
    );
    const client = readFileSync(
      join(process.cwd(), "src/app/(portal-editor)/admin/guides/editor/portal-editor-client.tsx"),
      "utf8",
    );

    expect(layout).toContain('requirePageUser("ADMIN_ACCESS")');
    expect(layout).not.toContain("AppShell");
    expect(page).toContain('requirePageUser("ADMIN_ACCESS")');
    expect(page).toContain("userId={user.id}");
    expect(client).toContain('"use client"');
    expect(client).toContain("dynamic(");
    expect(client).toContain("ssr: false");
    expect(client).toContain("<VisualEditor");
  });

  it("launches the immersive editor for all four cities while retaining the legacy editor", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/(admin)/admin/guides/page.tsx"),
      "utf8",
    );

    expect(page).toContain('"/admin/guides/editor?city=SHANGHAI&viewport=DESKTOP"');
    for (const city of ["上海", "深圳", "长沙", "西安"]) expect(page).toContain(city);
    expect(page).toContain("兼容旧版内容");
    expect(page).toContain("<GuideAdmin");
  });

  it("defines the bounded immersive shell around the production EditorStage", () => {
    const editor = readFileSync(
      join(process.cwd(), "src/features/portal/editor/visual-editor.tsx"),
      "utf8",
    );

    expect(editor).toContain("<EditorStage");
    expect(editor).toContain("defaultPortalScene");
    for (const landmark of [
      "返回指南管理",
      "城市",
      "桌面",
      "手机",
      "预览",
      "复制桌面到手机",
      "历史",
      "保存",
      "保存并发布",
      "添加组件",
      "页面设置",
      "素材库",
      "图层",
      "属性",
    ]) expect(editor).toContain(landmark);
  });

  it("exposes all four cities, both viewports, safe actions, and a labeled shared asset library", async () => {
    await renderLoaded();
    for (const city of ["上海", "深圳", "长沙", "西安"]) expect(screen.getByRole("tab", { name: city })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "桌面 1440×900" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "手机 390×844" })).toBeTruthy();
    for (const action of ["上传 Logo", "上传素材", "前移", "后移", "置顶", "置底", "删除元素", "替换素材", "复制桌面到手机", "员工预览", "保存草稿", "发布", "恢复上一版本"]) expect(screen.getByRole("button", { name: action })).toBeTruthy();
    expect(screen.getByText("全城共用素材库")).toBeTruthy();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("drags from the production wrapper and resizes from a real handle", () => {
    const onChange = vi.fn();
    render(<PortalCanvas viewport="DESKTOP" elements={[element()]} selectedId="hero" onSelect={() => undefined} onChange={onChange} />);
    expect(screen.getAllByRole("button", { name: /调整大小/ })).toHaveLength(8);
    const wrapper = document.querySelector(".portal-canvas-element") as HTMLElement;
    fireEvent.pointerDown(wrapper, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ x: 40, y: 60 })]));
    fireEvent.pointerDown(screen.getByRole("button", { name: "右下调整大小" }), { clientX: 50, clientY: 70, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 90, pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ width: 270, height: 140 })]));
  });

  it("marks numeric edits dirty, blocks publish/copy, then saves the visible coordinates", async () => {
    const { calls } = await renderLoaded();
    fireEvent.pointerDown(document.querySelector(".portal-canvas-element") as HTMLElement);
    fireEvent.change(screen.getByLabelText("X 坐标"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    expect(await screen.findByText("当前画布未保存，无法发布，请先保存草稿")).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith("/publish"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "复制桌面到手机" }));
    expect(await screen.findByText("当前桌面画布未保存，无法复制，请先保存草稿")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/draft") && call.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("桌面草稿已保存");
    const save = calls.find((call) => call.url.endsWith("/draft") && call.method === "PATCH");
    expect(JSON.parse(String(save?.body)).elements[0].x).toBe(99);
  });

  it("requires explicit confirmation that both saved viewports will publish", async () => {
    const { calls } = await renderLoaded();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(0);
    expect(await screen.findByText("已取消发布；桌面和手机草稿均未发布")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    expect(await screen.findByText("上海门户版本 2 已发布")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[0]).toContain("桌面（1440×900）和手机（390×844）最后保存的草稿");
  });

  it("confirms dirty city navigation and preserves edits when cancelled", async () => {
    await renderLoaded();
    fireEvent.pointerDown(document.querySelector(".portal-canvas-element") as HTMLElement);
    fireEvent.change(screen.getByLabelText("X 坐标"), { target: { value: "88" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("tab", { name: "深圳" }));
    expect(screen.getByRole("tab", { name: "上海" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("X 坐标") as HTMLInputElement).value).toBe("88");
    fireEvent.click(screen.getByRole("tab", { name: "深圳" }));
    await screen.findByRole("img", { name: "办公环境" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "深圳" }).getAttribute("aria-selected")).toBe("true"));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("clears stale elements and disables mutations when a new context load fails", async () => {
    await renderLoaded({ failCity: "SHENZHEN" });
    fireEvent.click(screen.getByRole("tab", { name: "深圳" }));
    await screen.findByText("加载失败");
    expect(document.querySelector(".portal-canvas-element")).toBeNull();
    expect((screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发布" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a true employee viewer preview and exits back to editor controls", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "员工预览" }));
    expect(document.querySelector(".portal-viewer")).not.toBeNull();
    expect(screen.getByLabelText("预览（未发布）")).toBeTruthy();
    expect(screen.queryByLabelText("四城门户发布版本 0")).toBeNull();
    expect(document.querySelector(".portal-canvas")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /调整大小/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "退出员工预览" }));
    expect(document.querySelector(".portal-canvas")).not.toBeNull();
  });

  it("preserves authored alt text when replacing an asset", async () => {
    const { calls } = await renderLoaded();
    fireEvent.pointerDown(document.querySelector(".portal-canvas-element") as HTMLElement);
    fireEvent.change(screen.getByLabelText("替代文字"), { target: { value: "上海接待大厅" } });
    fireEvent.change(screen.getByLabelText("素材库"), { target: { value: "asset-2" } });
    fireEvent.click(screen.getByRole("button", { name: "替换素材" }));
    expect((screen.getByLabelText("替代文字") as HTMLInputElement).value).toBe("上海接待大厅");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("桌面草稿已保存");
    const save = calls.find((call) => call.url.endsWith("/draft") && call.method === "PATCH");
    expect(JSON.parse(String(save?.body)).elements[0]).toMatchObject({ assetId: "asset-2", altText: "上海接待大厅" });
  });

  it("blocks deletion when the current local canvas references the selected shared asset", async () => {
    const { calls } = await renderLoaded();
    fireEvent.change(screen.getByLabelText("素材库"), { target: { value: "asset-1" } });
    fireEvent.click(screen.getByRole("button", { name: "删除未引用素材" }));
    expect(await screen.findByText("当前画布仍引用该素材，请先删除或替换元素并保存草稿")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("keeps a late upload in the shared library without appending it to a switched context", async () => {
    let resolveUpload!: (response: Response) => void;
    const upload = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    await renderLoaded({ upload });
    const input = screen.getByLabelText("上传素材文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["image"], "late.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /^上传素材$/ }));
    fireEvent.click(screen.getByRole("tab", { name: "深圳" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "深圳" }).getAttribute("aria-selected")).toBe("true"));
    await act(async () => resolveUpload(Response.json({ ok: true, asset: { id: "asset-late", originalName: "late.png", mimeType: "image/png", sizeBytes: 5, url: "/api/files/asset-late" } }, { status: 201 })));
    await waitFor(() => expect(screen.getByRole("option", { name: "late.png" })).toBeTruthy());
    expect(document.querySelector('img[src="/api/files/asset-late"]')).toBeNull();
  });

  it("shows a clear message when a mutation re-enters before React disables the control", async () => {
    let resolveSave!: (response: Response) => void;
    const save = new Promise<Response>((resolve) => { resolveSave = resolve; });
    await renderLoaded({ save });
    const button = screen.getByRole("button", { name: "保存草稿" });
    act(() => { button.click(); button.click(); });
    expect(await screen.findByText("请等待当前操作完成")).toBeTruthy();
    await act(async () => resolveSave(Response.json({ ok: true, draft: { elements: [element()] } })));
  });

  it("surfaces the honest one-version restore error", async () => {
    await renderLoaded({ restore: Promise.resolve(Response.json({ ok: false, code: "PUBLICATION_NOT_FOUND", message: "没有更早的发布版本" }, { status: 404 })) });
    fireEvent.click(screen.getByRole("button", { name: "恢复上一版本" }));
    expect(await screen.findByText("没有更早的发布版本")).toBeTruthy();
  });

  it("shows actionable guidance from a structurally rejected upload", async () => {
    const guidance = "图片文件结构无效或不受支持，请重新导出为 PNG、JPG、WebP 或 GIF 后上传";
    await renderLoaded({ upload: Promise.resolve(Response.json({ ok: false, code: "INVALID_STRUCTURE", message: guidance }, { status: 400 })) });
    fireEvent.change(screen.getByLabelText("上传素材文件"), { target: { files: [new File(["broken"], "broken.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /^上传素材$/ }));
    expect(await screen.findByText(guidance)).toBeTruthy();
  });

  it("saturates layer moves and uploaded elements at the z-index schema bounds", async () => {
    const draftElements = [
      element(),
      { ...element("highest", "asset-1", "最高层"), zIndex: 10_000 },
      { ...element("lowest", "asset-1", "最低层"), zIndex: -10_000 },
    ];
    const upload = Promise.resolve(Response.json({
      ok: true,
      asset: { id: "asset-top", originalName: "top.png", mimeType: "image/png", sizeBytes: 5, url: "/api/files/asset-top" },
    }, { status: 201 }));
    const { calls } = await renderLoaded({ draftElements, upload });

    fireEvent.pointerDown(screen.getByRole("img", { name: "最高层" }).closest(".portal-canvas-element") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "前移" }));
    fireEvent.pointerDown(screen.getByRole("img", { name: "最低层" }).closest(".portal-canvas-element") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "后移" }));
    fireEvent.change(screen.getByLabelText("上传素材文件"), { target: { files: [new File(["png"], "top.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /^上传素材$/ }));
    await screen.findByText("素材 已加入桌面布局");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("桌面草稿已保存");

    const save = calls.findLast((call) => call.url.endsWith("/draft") && call.method === "PATCH");
    const saved = JSON.parse(String(save?.body)).elements as Element[];
    expect(saved.find((item) => item.id === "highest")?.zIndex).toBe(10_000);
    expect(saved.find((item) => item.id === "lowest")?.zIndex).toBe(-10_000);
    expect(saved.find((item) => item.assetId === "asset-top")?.zIndex).toBe(10_000);
  });
});
