// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuideViewer } from "@/features/guides/components/guide-viewer";
import { portalSceneV1Schema } from "@/features/portal/portal-scene";

const guide = {
  title: "上海入职指南",
  summary: "欢迎来到上海办公室",
  chapters: [{
    id: "chapter-1",
    title: "旧版交通章节",
    body: "仅在旧版门户下显示",
    address: null,
    contact: null,
    externalUrl: null,
    imageAsset: null,
  }],
};

const v1Scene = portalSceneV1Schema.parse({
  sceneVersion: 1,
  viewport: "MOBILE",
  requiresMobileReview: false,
  background: {
    assetId: null,
    fitMode: "COVER",
    positionX: 50,
    positionY: 50,
    backgroundColor: "#FFFFFF",
    locked: false,
  },
  elements: [{
    id: "welcome",
    name: "欢迎",
    type: "TEXT",
    text: "欢迎来到上海",
    color: "#112233",
    fontFamily: "Noto Sans SC Variable",
    fontSize: 24,
    fontWeight: 600,
    lineHeight: 1.4,
    align: "CENTER",
    x: 20,
    y: 20,
    width: 300,
    height: 80,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    locked: false,
    hidden: false,
  }],
});

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function setMobile(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches,
    media: "(max-width: 760px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function mockFetch(portalBody: unknown, portalStatus = 200) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/guides/")) {
      return response({
        ok: true,
        guide,
        watermarkName: "示例员工",
        watermarkOpacity: 0.07,
      });
    }
    return response(portalBody, portalStatus);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuideViewer publication selection", () => {
  it("fetches MOBILE at 760px and makes V1 the only published page", async () => {
    setMobile(true);
    const fetchMock = mockFetch({
      ok: true,
      portal: { sceneVersion: 1, version: 7, scene: v1Scene },
    });

    render(<GuideViewer city="SHANGHAI" />);

    expect(await screen.findByRole("region", { name: "四城门户发布版本 7" })).toBeTruthy();
    expect(screen.getByText("欢迎来到上海")).toBeTruthy();
    expect(screen.queryByText("旧版交通章节")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/portal/SHANGHAI?viewport=MOBILE",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the legacy portal and chapters for a native V0 publication", async () => {
    setMobile(false);
    mockFetch({
      ok: true,
      portal: {
        sceneVersion: 0,
        version: 3,
        viewport: "DESKTOP",
        canvasWidth: 1_440,
        canvasHeight: 900,
        elements: [{
          id: "legacy",
          kind: "IMAGE",
          assetId: "asset-id",
          assetUrl: "/api/files/asset-id",
          x: 0,
          y: 0,
          width: 1_440,
          height: 900,
          zIndex: 0,
          altText: "旧版门户",
        }],
      },
    });

    render(<GuideViewer city="SHANGHAI" />);

    expect(await screen.findByRole("region", { name: "四城门户发布版本 3" })).toBeTruthy();
    expect(screen.getByAltText("旧版门户")).toBeTruthy();
    expect(screen.getByText("旧版交通章节")).toBeTruthy();
  });

  it("distinguishes no publication from portal load failure with friendly recoverable states", async () => {
    setMobile(false);
    mockFetch({ ok: true, portal: null });
    const { unmount } = render(<GuideViewer city="SHANGHAI" />);

    expect(await screen.findByText("上海入职指南的门户内容尚未发布。")).toBeTruthy();
    unmount();

    mockFetch({ ok: false, message: "读取失败" }, 500);
    render(<GuideViewer city="SHANGHAI" />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("门户内容加载失败");
    });
    expect(screen.queryByText("上海入职指南的门户内容尚未发布。")).toBeNull();
  });
});
