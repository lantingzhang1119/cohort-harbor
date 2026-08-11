// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorStageProps } from "@/features/portal/editor/editor-stage";
import { recoveryKey } from "@/features/portal/editor/editor-recovery";
import { VisualEditor } from "@/features/portal/editor/visual-editor";
import {
  defaultPortalScene,
  portalSceneV1Schema,
  type PortalSceneV1,
  type PortalViewportInput,
} from "@/features/portal/portal-scene";

vi.mock("@/features/portal/editor/editor-stage", () => ({
  EditorStage({ state, dispatch, cropTargetId, onCropExit }: EditorStageProps) {
    return (
      <section aria-label="测试画布">
        <output data-testid="scene">
          {JSON.stringify({
            city: state.city,
            viewport: state.viewport,
            revision: state.revision,
            dirty: state.dirty,
            color: state.present.background.backgroundColor,
            requiresMobileReview: state.present.requiresMobileReview,
            history: state.past.length,
            scene: state.present,
            selection: state.selection,
            zoom: state.zoom,
            snapEnabled: state.snapEnabled,
          })}
        </output>
        <button
          type="button"
          onClick={() => dispatch({
            type: "UPDATE_BACKGROUND",
            patch: { backgroundColor: "#123456" },
          })}
        >
          修改测试场景
        </button>
        <button
          type="button"
          onClick={() => dispatch({
            type: "UPDATE_BACKGROUND",
            patch: { backgroundColor: "#FEDCBA" },
          })}
        >
          修改为后续场景
        </button>
        {cropTargetId && (
          <>
            <button
              type="button"
              onClick={() => dispatch({
                type: "PREVIEW_ELEMENT",
                id: cropTargetId,
                patch: { crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } },
              })}
            >
              测试预览裁剪
            </button>
            <button
              type="button"
              onClick={() => {
                dispatch({
                  type: "COMMIT_ELEMENT",
                  id: cropTargetId,
                  patch: { crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } },
                });
                dispatch({ type: "CLEAR_PREVIEW" });
                onCropExit?.();
              }}
            >
              测试应用裁剪
            </button>
            <button
              type="button"
              onClick={() => {
                dispatch({ type: "CLEAR_PREVIEW" });
                onCropExit?.();
              }}
            >
              测试取消裁剪
            </button>
            <button
              type="button"
              onClick={() => dispatch({
                type: "SELECT_ELEMENT",
                id: null,
                source: "CANVAS",
              })}
            >
              测试切换裁剪目标
            </button>
            <button
              type="button"
              onClick={() => dispatch({
                type: "COMMIT_ELEMENT",
                id: cropTargetId,
                patch: { assetId: "asset-replaced" },
              })}
            >
              测试更换裁剪素材
            </button>
            <button
              type="button"
              onClick={() => dispatch({
                type: "COMMIT_ELEMENT",
                id: cropTargetId,
                patch: { fitMode: "CONTAIN" },
              })}
            >
              测试更改裁剪显示方式
            </button>
            <button
              type="button"
              onClick={() => dispatch({
                type: "SET_ELEMENT_LOCKED",
                id: cropTargetId,
                locked: true,
              })}
            >
              测试锁定裁剪目标
            </button>
            <button
              type="button"
              onClick={() => dispatch({
                type: "SET_ELEMENT_HIDDEN",
                id: cropTargetId,
                hidden: true,
              })}
            >
              测试隐藏裁剪目标
            </button>
          </>
        )}
      </section>
    );
  },
}));

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function scene(viewport: PortalViewportInput, color: string, requiresMobileReview = false) {
  return {
    ...defaultPortalScene(viewport),
    requiresMobileReview,
    background: {
      ...defaultPortalScene(viewport).background,
      backgroundColor: color,
    },
  } satisfies PortalSceneV1;
}

function draftResponse(
  viewport: PortalViewportInput,
  revision: number,
  color: string,
  requiresMobileReview = false,
) {
  return Response.json({
    ok: true,
    draft: {
      viewport,
      revision,
      scene: scene(viewport, color, requiresMobileReview),
    },
  });
}

function assetRecord(id = "asset-real") {
  return {
    id,
    originalName: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-07-26T00:00:00.000Z",
    category: "IMAGE",
    width: 800,
    height: 600,
    inspectionStatus: "VALID",
    searchText: `${id}.png image/png image 800x600`,
    references: { draft: [], current: [], history: [] },
    referenceCounts: { draft: 0, current: 0, history: 0 },
    unused: true,
    url: `/api/files/${id}`,
  };
}

function parsedScene() {
  return JSON.parse(screen.getByTestId("scene").textContent ?? "{}") as {
    city: string;
    viewport: PortalViewportInput;
    revision: number;
    dirty: boolean;
    color: string;
    requiresMobileReview: boolean;
    history: number;
    scene: PortalSceneV1;
    selection: string[];
    zoom: number;
    snapEnabled: boolean;
  };
}

function bodyOf(call: FetchCall | undefined) {
  return JSON.parse(String(call?.body));
}

function installFetch(
  handler: (
    call: FetchCall,
    calls: FetchCall[],
  ) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body,
    };
    calls.push(call);
    return handler(call, calls);
  }));
  return calls;
}

async function renderLoaded(
  handler: Parameters<typeof installFetch>[0],
  props: Partial<React.ComponentProps<typeof VisualEditor>> = {},
) {
  const calls = installFetch(handler);
  render(
    <VisualEditor
      userId="admin-real-id"
      initialCity="SHANGHAI"
      initialViewport="DESKTOP"
      {...props}
    />,
  );
  await waitFor(() => expect(parsedScene().revision).not.toBe(0));
  return calls;
}

function installMemoryStorage() {
  const create = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(key: string) {
        return map.has(key) ? map.get(key)! : null;
      },
      key(index: number) {
        return [...map.keys()][index] ?? null;
      },
      removeItem(key: string) {
        map.delete(key);
      },
      setItem(key: string, value: string) {
        map.set(key, String(value));
      },
    };
  };
  // Node 26 may expose a non-functional global localStorage that shadows jsdom.
  if (typeof window.localStorage?.clear !== "function") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: create(),
    });
  }
  if (typeof window.sessionStorage?.clear !== "function") {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      writable: true,
      value: create(),
    });
  }
}

beforeEach(() => {
  installMemoryStorage();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("visual editor workflow", () => {
  it("loads a strict captured context, saves the exact reducer scene, then adopts the server draft", async () => {
    const calls = await renderLoaded((call) => {
      if (call.method === "GET") return draftResponse("DESKTOP", 3, "#AAAAAA");
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#654321");
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });

    expect(calls[0]).toMatchObject({
      url: "/api/admin/portal/SHANGHAI/draft?viewport=DESKTOP",
      method: "GET",
    });
    expect(parsedScene()).toMatchObject({
      city: "SHANGHAI",
      viewport: "DESKTOP",
      revision: 3,
      color: "#AAAAAA",
      dirty: false,
      history: 0,
    });

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    expect(parsedScene()).toMatchObject({ revision: 3, dirty: true, history: 1 });
    await waitFor(() => {
      const raw = window.sessionStorage.getItem(
        recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
      );
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        savedAt: expect.any(String),
        scene: { background: { backgroundColor: "#123456" } },
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("桌面草稿已保存");
    const save = calls.find((call) => call.method === "PATCH");
    expect(save?.url).toBe("/api/admin/portal/SHANGHAI/draft");
    expect(bodyOf(save)).toEqual({
      viewport: "DESKTOP",
      revision: 3,
      scene: scene("DESKTOP", "#123456"),
    });
    expect(parsedScene()).toMatchObject({
      revision: 4,
      color: "#654321",
      dirty: false,
      history: 0,
    });
    expect(window.sessionStorage.getItem(
      recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
    )).toBeNull();
  });

  it("keeps edits made while a save is in flight and advances only the server revision", async () => {
    const lateSave = deferred<Response>();
    await renderLoaded((call) => {
      if (call.method === "GET") return draftResponse("DESKTOP", 3, "#AAAAAA");
      if (call.method === "PATCH") return lateSave.promise;
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await userEvent.click(screen.getByRole("button", { name: "修改为后续场景" }));
    await act(async () => {
      lateSave.resolve(draftResponse("DESKTOP", 4, "#123456"));
    });

    await waitFor(() => expect(parsedScene()).toMatchObject({
      revision: 4,
      color: "#FEDCBA",
      dirty: true,
    }));
    expect(screen.getByText("保存期间产生了新修改，后续修改仍未保存")).toBeTruthy();
    await waitFor(() => {
      const raw = window.sessionStorage.getItem(
        recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
      );
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        scene: { background: { backgroundColor: "#FEDCBA" } },
      });
    });
  });

  it("discards late load and save responses after the city or viewport context changes", async () => {
    const lateShanghai = deferred<Response>();
    const lateSave = deferred<Response>();
    const calls = installFetch((call) => {
      if (call.method === "PATCH") return lateSave.promise;
      if (call.url.includes("/SHANGHAI/")) return lateShanghai.promise;
      if (call.url.includes("/SHENZHEN/") && call.url.includes("viewport=MOBILE")) {
        return draftResponse("MOBILE", 9, "#000088");
      }
      if (call.url.includes("/SHENZHEN/")) return draftResponse("DESKTOP", 8, "#008800");
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });
    render(
      <VisualEditor
        userId="admin-real-id"
        initialCity="SHANGHAI"
        initialViewport="DESKTOP"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      city: "SHENZHEN",
      revision: 8,
      color: "#008800",
    }));
    await act(async () => lateShanghai.resolve(draftResponse("DESKTOP", 99, "#990000")));
    expect(parsedScene()).toMatchObject({
      city: "SHENZHEN",
      revision: 8,
      color: "#008800",
    });

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    // City/device buttons lock during save so a concurrent switch cannot race the draft write.
    expect((screen.getByRole("button", { name: "手机" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "上海" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => lateSave.resolve(draftResponse("DESKTOP", 100, "#FF0000")));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      city: "SHENZHEN",
      viewport: "DESKTOP",
      revision: 100,
      color: "#FF0000",
      dirty: false,
    }));
    expect(bodyOf(calls.find((call) => call.method === "PATCH"))).toMatchObject({
      viewport: "DESKTOP",
      revision: 8,
      scene: { background: { backgroundColor: "#123456" } },
    });
    // After save completes, device switch works and late Shanghai load is still ignored.
    await userEvent.click(screen.getByRole("button", { name: "手机" }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      city: "SHENZHEN",
      viewport: "MOBILE",
      revision: 9,
      color: "#000088",
    }));
  });

  it("keeps a local scene on 409 and can stash, reapply over the latest revision, and retry", async () => {
    let getCount = 0;
    let patchCount = 0;
    const calls = await renderLoaded((call) => {
      if (call.method === "GET") {
        getCount += 1;
        return getCount === 1
          ? draftResponse("DESKTOP", 2, "#AAAAAA")
          : draftResponse("DESKTOP", 7, "#777777");
      }
      if (call.method === "PATCH") {
        patchCount += 1;
        return patchCount === 1
          ? Response.json({
              ok: false,
              code: "DRAFT_CONFLICT",
              message: "草稿冲突",
            }, { status: 409 })
          : draftResponse("DESKTOP", 8, "#123456");
      }
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("草稿冲突");
    expect(parsedScene()).toMatchObject({
      revision: 2,
      color: "#123456",
      dirty: true,
    });
    expect(screen.getByRole("button", { name: "载入服务器版本" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", {
      name: "暂存本地副本后重新套用",
    }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      revision: 7,
      color: "#123456",
      dirty: true,
    }));
    expect(JSON.parse(window.sessionStorage.getItem(
      recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
    ) ?? "{}")).toMatchObject({
      scene: { background: { backgroundColor: "#123456" } },
    });

    await userEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await screen.findByText("桌面草稿已保存");
    expect(bodyOf(calls.filter((call) => call.method === "PATCH")[1])).toEqual({
      viewport: "DESKTOP",
      revision: 7,
      scene: scene("DESKTOP", "#123456"),
    });
    expect(parsedScene()).toMatchObject({ revision: 8, dirty: false });
  });

  it("keeps edits made while conflict reapply is loading and preserves their recovery copy", async () => {
    const lateServer = deferred<Response>();
    let getCount = 0;
    await renderLoaded((call) => {
      if (call.method === "GET") {
        getCount += 1;
        return getCount === 1
          ? draftResponse("DESKTOP", 2, "#AAAAAA")
          : lateServer.promise;
      }
      return Response.json({
        ok: false,
        code: "DRAFT_CONFLICT",
        message: "草稿冲突",
      }, { status: 409 });
    });

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", {
      name: "暂存本地副本后重新套用",
    }));
    await userEvent.click(screen.getByRole("button", { name: "修改为后续场景" }));
    await waitFor(() => {
      const raw = window.sessionStorage.getItem(
        recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
      );
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        scene: { background: { backgroundColor: "#FEDCBA" } },
      });
    });

    await act(async () => {
      lateServer.resolve(draftResponse("DESKTOP", 7, "#777777"));
    });

    expect(await screen.findByText("重新套用期间产生了新修改，请重新处理冲突")).toBeTruthy();
    expect(parsedScene()).toMatchObject({
      revision: 2,
      color: "#FEDCBA",
      dirty: true,
    });
    expect(screen.getByRole("button", {
      name: "暂存本地副本后重新套用",
    })).toBeTruthy();
    const raw = window.sessionStorage.getItem(
      recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP"),
    );
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      scene: { background: { backgroundColor: "#FEDCBA" } },
    });
  });

  it("can discard a conflicted local scene and load the authoritative server version", async () => {
    let getCount = 0;
    await renderLoaded((call) => {
      if (call.method === "GET") {
        getCount += 1;
        return getCount === 1
          ? draftResponse("DESKTOP", 2, "#AAAAAA")
          : draftResponse("DESKTOP", 6, "#666666");
      }
      return Response.json({
        ok: false,
        code: "DRAFT_CONFLICT",
        message: "草稿冲突",
      }, { status: 409 });
    });
    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await userEvent.click(screen.getByRole("button", { name: "载入服务器版本" }));

    await waitFor(() => expect(parsedScene()).toMatchObject({
      revision: 6,
      color: "#666666",
      dirty: false,
    }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("guards dirty context switches, beforeunload, and the return link", async () => {
    const calls = await renderLoaded((call) => {
      const viewport = call.url.includes("viewport=MOBILE") ? "MOBILE" : "DESKTOP";
      const city = call.url.includes("/SHENZHEN/") ? "SHENZHEN" : "SHANGHAI";
      return draftResponse(viewport, city === "SHENZHEN" ? 5 : 3, city === "SHENZHEN" ? "#555555" : "#333333");
    });
    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    expect(parsedScene()).toMatchObject({ city: "SHANGHAI", color: "#123456" });
    await userEvent.click(screen.getByRole("button", { name: "手机" }));
    expect(parsedScene()).toMatchObject({ viewport: "DESKTOP", color: "#123456" });

    const back = screen.getByRole("link", { name: /返回指南管理/ });
    expect(fireEvent.click(back)).toBe(false);
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      city: "SHENZHEN",
      revision: 5,
      dirty: false,
    }));
    expect(calls.some((call) => call.url.includes("/SHENZHEN/draft?viewport=DESKTOP"))).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(4);
  });

  it("offers user-scoped recovery, clears it after save, and handles logout cleanup", async () => {
    const key = recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP");
    window.sessionStorage.setItem(key, JSON.stringify({
      savedAt: new Date().toISOString(),
      scene: scene("DESKTOP", "#ABCDEF"),
    }));
    window.sessionStorage.setItem(
      recoveryKey("admin-real-id", "SHENZHEN", "MOBILE"),
      JSON.stringify({
        savedAt: new Date().toISOString(),
        scene: scene("MOBILE", "#ABCDEF"),
      }),
    );
    window.sessionStorage.setItem(
      recoveryKey("another-user", "SHANGHAI", "DESKTOP"),
      JSON.stringify({
        savedAt: new Date().toISOString(),
        scene: scene("DESKTOP", "#ABCDEF"),
      }),
    );

    await renderLoaded((call) => call.method === "GET"
      ? draftResponse("DESKTOP", 3, "#333333")
      : draftResponse("DESKTOP", 4, "#ABCDEF"));
    expect(await screen.findByText("发现此画布的本地恢复副本")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "恢复本地副本" }));
    expect(parsedScene()).toMatchObject({ color: "#ABCDEF", dirty: true, revision: 3 });

    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("桌面草稿已保存");
    expect(window.sessionStorage.getItem(key)).toBeNull();

    window.dispatchEvent(new Event("portal-recovery-clear"));
    expect(window.sessionStorage.getItem(
      recoveryKey("admin-real-id", "SHENZHEN", "MOBILE"),
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      recoveryKey("another-user", "SHANGHAI", "DESKTOP"),
    )).not.toBeNull();
  });

  it("saves current context, confirms mobile review, and publishes one city's fresh revision pair", async () => {
    const calls = await renderLoaded((call, allCalls) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#123456");
      if (call.method === "POST" && call.url.endsWith("/draft")) {
        return draftResponse("MOBILE", 8, "#BBBBBB", false);
      }
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        return Response.json({ ok: true, city: "SHANGHAI", version: 12 }, { status: 201 });
      }
      if (call.method === "GET" && call.url.includes("viewport=MOBILE")) {
        return draftResponse("MOBILE", 7, "#BBBBBB", true);
      }
      if (call.method === "GET" && allCalls.filter((entry) => entry.method === "GET").length > 1) {
        return draftResponse("DESKTOP", 4, "#123456");
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));

    expect(await screen.findByText("手机版需要人工审查")).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "已检查手机版，继续发布",
    })).toBeNull();
    const save = calls.find((call) => call.method === "PATCH");
    expect(bodyOf(save)).toEqual({
      viewport: "DESKTOP",
      revision: 3,
      scene: scene("DESKTOP", "#123456"),
    });
    await userEvent.click(screen.getByRole("button", {
      name: "进入手机版检查",
    }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      viewport: "MOBILE",
      revision: 7,
      requiresMobileReview: true,
    }));
    await userEvent.click(screen.getByRole("button", {
      name: "已检查手机版，继续发布",
    }));
    expect(await screen.findByText("上海门户版本 12 已发布")).toBeTruthy();

    const confirmReview = calls.find((call) =>
      call.method === "POST" && call.url.endsWith("/draft"));
    expect(bodyOf(confirmReview)).toEqual({
      action: "CONFIRM_MOBILE_REVIEW",
      revision: 7,
    });
    const publish = calls.find((call) =>
      call.method === "POST" && call.url.endsWith("/publish"));
    expect(publish?.url).toBe("/api/admin/portal/SHANGHAI/publish");
    expect(bodyOf(publish)).toEqual({
      revisions: { desktop: 4, mobile: 8 },
    });
  });

  it("locks city switching during publish and ignores late pair after city changes", async () => {
    const lateDesktop = deferred<Response>();
    const lateMobile = deferred<Response>();
    let initialLoaded = false;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#123456");
      if (call.method === "GET" && call.url.includes("/SHENZHEN/")) {
        return draftResponse("DESKTOP", 20, "#202020");
      }
      if (!initialLoaded) {
        initialLoaded = true;
        return draftResponse("DESKTOP", 3, "#AAAAAA");
      }
      if (call.method === "GET" && call.url.includes("viewport=MOBILE")) return lateMobile.promise;
      if (call.method === "GET") return lateDesktop.promise;
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(3));
    // City switch is locked while publish/save is in flight.
    expect((screen.getByRole("button", { name: "深圳" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      lateDesktop.resolve(draftResponse("DESKTOP", 4, "#123456"));
      // Mobile still requires review → publish aborts before POST /publish.
      lateMobile.resolve(draftResponse("MOBILE", 7, "#BBBBBB", true));
    });
    expect(await screen.findByText("手机版需要人工审查")).toBeTruthy();
    expect(parsedScene().city).toBe("SHANGHAI");
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(0);
    // After publish workflow releases the lock, switching city is allowed again.
    expect((screen.getByRole("button", { name: "深圳" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(0);
  });

  it("adopts the confirmed mobile revision when publishing from the mobile context", async () => {
    let initialLoad = true;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("MOBILE", 8, "#BBBBBB", true);
      if (call.method === "POST" && call.url.endsWith("/draft")) {
        return draftResponse("MOBILE", 9, "#BBBBBB", false);
      }
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        return Response.json({ ok: true, city: "SHANGHAI", version: 13 }, { status: 201 });
      }
      if (initialLoad) {
        initialLoad = false;
        return draftResponse("MOBILE", 7, "#BBBBBB", true);
      }
      if (call.url.includes("viewport=DESKTOP")) return draftResponse("DESKTOP", 4, "#AAAAAA");
      return draftResponse("MOBILE", 8, "#BBBBBB", true);
    }, { initialViewport: "MOBILE" });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    await screen.findByText("手机版需要人工审查");
    await userEvent.click(screen.getByRole("button", {
      name: "已检查手机版，继续发布",
    }));
    await screen.findByText("上海门户版本 13 已发布");

    expect(parsedScene()).toMatchObject({
      viewport: "MOBILE",
      revision: 9,
      requiresMobileReview: false,
      dirty: false,
    });
    expect(bodyOf(calls.find((call) =>
      call.method === "POST" && call.url.endsWith("/publish"),
    ))).toEqual({ revisions: { desktop: 4, mobile: 9 } });
  });

  it("keeps edits made while mobile review confirmation is in flight and stops publication", async () => {
    const lateReview = deferred<Response>();
    let initialLoad = true;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("MOBILE", 8, "#BBBBBB", true);
      if (call.method === "POST" && call.url.endsWith("/draft")) return lateReview.promise;
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        return Response.json({ ok: true, city: "SHANGHAI", version: 99 }, { status: 201 });
      }
      if (initialLoad) {
        initialLoad = false;
        return draftResponse("MOBILE", 7, "#BBBBBB", true);
      }
      if (call.url.includes("viewport=DESKTOP")) return draftResponse("DESKTOP", 4, "#AAAAAA");
      return draftResponse("MOBILE", 8, "#BBBBBB", true);
    }, { initialViewport: "MOBILE" });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    await screen.findByText("手机版需要人工审查");
    await userEvent.click(screen.getByRole("button", {
      name: "已检查手机版，继续发布",
    }));
    await userEvent.click(screen.getByRole("button", { name: "修改为后续场景" }));
    await act(async () => {
      lateReview.resolve(draftResponse("MOBILE", 9, "#BBBBBB", false));
    });

    await waitFor(() => expect(parsedScene()).toMatchObject({
      viewport: "MOBILE",
      revision: 9,
      color: "#FEDCBA",
      dirty: true,
      requiresMobileReview: true,
    }));
    expect(await screen.findByText("确认期间产生了新修改，请重新保存并检查手机版")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(0);
    await waitFor(() => {
      const raw = window.sessionStorage.getItem(
        recoveryKey("admin-real-id", "SHANGHAI", "MOBILE"),
      );
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        scene: { background: { backgroundColor: "#FEDCBA" } },
      });
    });
  });

  it("stops publication when the local scene changes while the revision pair is loading", async () => {
    const lateDesktop = deferred<Response>();
    const lateMobile = deferred<Response>();
    let initialLoaded = false;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#AAAAAA");
      if (!initialLoaded) {
        initialLoaded = true;
        return draftResponse("DESKTOP", 3, "#AAAAAA");
      }
      if (call.method === "GET" && call.url.includes("viewport=MOBILE")) return lateMobile.promise;
      if (call.method === "GET") return lateDesktop.promise;
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        return Response.json({ ok: true, city: "SHANGHAI", version: 99 }, { status: 201 });
      }
      throw new Error(`Unhandled ${call.method} ${call.url}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(3));
    await userEvent.click(screen.getByRole("button", { name: "修改为后续场景" }));
    await act(async () => {
      lateDesktop.resolve(draftResponse("DESKTOP", 4, "#AAAAAA"));
      lateMobile.resolve(draftResponse("MOBILE", 7, "#BBBBBB"));
    });

    expect(await screen.findByText("校验期间产生了新修改，请再次保存并发布")).toBeTruthy();
    expect(parsedScene()).toMatchObject({ color: "#FEDCBA", dirty: true });
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(0);
  });

  it("keeps a fresh revision pair available for an explicit publish retry", async () => {
    let initialLoad = true;
    let publishCount = 0;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#AAAAAA");
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        publishCount += 1;
        if (publishCount === 1) {
          return Response.json({ ok: false, message: "发布暂时失败" }, { status: 500 });
        }
        if (publishCount === 2) {
          return Response.json({ ok: false, message: "发布仍然失败" }, { status: 500 });
        }
        return Response.json({ ok: true, city: "SHANGHAI", version: 14 }, { status: 201 });
      }
      if (initialLoad) {
        initialLoad = false;
        return draftResponse("DESKTOP", 3, "#AAAAAA");
      }
      if (call.url.includes("viewport=MOBILE")) return draftResponse("MOBILE", 7, "#BBBBBB");
      return draftResponse("DESKTOP", 4, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    expect(await screen.findByText("发布暂时失败")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试发布" }));
    expect(await screen.findByText("发布仍然失败")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试发布" }));
    expect(await screen.findByText("上海门户版本 14 已发布")).toBeTruthy();
    expect(calls.filter((call) =>
      call.method === "POST" && call.url.endsWith("/publish"),
    )).toHaveLength(3);
  });

  it("retries the mobile review confirmation itself before publishing", async () => {
    let initialLoad = true;
    let reviewCount = 0;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#AAAAAA");
      if (call.method === "POST" && call.url.endsWith("/draft")) {
        reviewCount += 1;
        return reviewCount === 1
          ? Response.json({ ok: false, message: "确认审查失败" }, { status: 500 })
          : draftResponse("MOBILE", 8, "#BBBBBB", false);
      }
      if (call.method === "POST" && call.url.endsWith("/publish")) {
        return Response.json({ ok: true, city: "SHANGHAI", version: 15 }, { status: 201 });
      }
      if (initialLoad) {
        initialLoad = false;
        return draftResponse("DESKTOP", 3, "#AAAAAA");
      }
      if (call.url.includes("viewport=MOBILE")) {
        return draftResponse("MOBILE", 7, "#BBBBBB", true);
      }
      return draftResponse("DESKTOP", 4, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    await userEvent.click(screen.getByRole("button", {
      name: "进入手机版检查",
    }));
    await waitFor(() => expect(parsedScene().viewport).toBe("MOBILE"));
    await userEvent.click(screen.getByRole("button", {
      name: "已检查手机版，继续发布",
    }));
    expect(await screen.findByText("确认审查失败")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", {
      name: "已检查手机版，继续发布",
    }));
    expect(await screen.findByText("上海门户版本 15 已发布")).toBeTruthy();
    expect(calls.filter((call) =>
      call.method === "POST" && call.url.endsWith("/draft"),
    )).toHaveLength(2);
  });

  it("ignores an old same-city asset response after leaving and returning to that city", async () => {
    const oldShanghaiAssets = deferred<Response>();
    let shanghaiAssetRequestCount = 0;
    await renderLoaded((call) => {
      if (call.url.includes("/assets")) {
        shanghaiAssetRequestCount += 1;
        return shanghaiAssetRequestCount === 1
          ? oldShanghaiAssets.promise
          : Response.json({ ok: true, assets: [assetRecord("asset-current")] });
      }
      const viewport = call.url.includes("viewport=MOBILE") ? "MOBILE" : "DESKTOP";
      const city = call.url.includes("/SHENZHEN/") ? "SHENZHEN" : "SHANGHAI";
      return draftResponse(viewport, city === "SHENZHEN" ? 5 : 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await waitFor(() => expect(shanghaiAssetRequestCount).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    await userEvent.click(screen.getByRole("button", { name: "上海" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHANGHAI"));
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    expect(await screen.findByText("asset-current.png")).toBeTruthy();

    await act(async () => {
      oldShanghaiAssets.resolve(Response.json({
        ok: true,
        assets: [assetRecord("asset-stale")],
      }));
    });
    expect(screen.getByText("asset-current.png")).toBeTruthy();
    expect(screen.queryByText("asset-stale.png")).toBeNull();
  });

  it("merges an upload from an earlier context without changing the new canvas or selection", async () => {
    const oldUpload = deferred<Response>();
    await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "POST") {
        return oldUpload.promise;
      }
      if (call.url.includes("/assets")) {
        return Response.json({
          ok: true,
          assets: [assetRecord("asset-current")],
        });
      }
      const city = call.url.includes("/SHENZHEN/") ? "SHENZHEN" : "SHANGHAI";
      return draftResponse(
        "DESKTOP",
        city === "SHENZHEN" ? 5 : 3,
        city === "SHENZHEN" ? "#ABCDEF" : "#FFFFFF",
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "页面设置" }));
    await screen.findByText("asset-current.png");
    await userEvent.upload(
      screen.getByLabelText("上传背景图片"),
      new File([new Uint8Array([1])], "asset-global.png", { type: "image/png" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    const currentAssetName = await screen.findByText("asset-current.png");
    expect(currentAssetName.closest("li")?.querySelector("button")?.getAttribute("aria-pressed"))
      .toBe("true");

    await act(async () => {
      oldUpload.resolve(Response.json({
        ok: true,
        asset: assetRecord("asset-global"),
      }, { status: 201 }));
    });
    expect(screen.getByText("asset-current.png")).toBeTruthy();
    expect(screen.getByText("asset-global.png")).toBeTruthy();
    expect(currentAssetName.closest("li")?.querySelector("button")?.getAttribute("aria-pressed"))
      .toBe("true");
    expect(parsedScene().scene.background).toMatchObject({
      assetId: null,
      backgroundColor: "#ABCDEF",
    });
    expect(screen.queryByText("asset-global.png 已上传")).toBeNull();
  });

  it("removes a globally deleted asset after switching context and loading an older snapshot", async () => {
    const deletion = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded((call) => {
      if (call.url.includes("assetId=asset-global")) return deletion.promise;
      if (call.url.includes("/assets")) {
        return Response.json({ ok: true, assets: [assetRecord("asset-global")] });
      }
      const city = call.url.includes("/SHENZHEN/") ? "SHENZHEN" : "SHANGHAI";
      return draftResponse("DESKTOP", city === "SHENZHEN" ? 5 : 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("asset-global.png");
    await userEvent.click(screen.getByRole("button", { name: "删除素材" }));
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    const selectedAssetName = await screen.findByText("asset-global.png");
    expect(selectedAssetName.closest("li")?.querySelector("button")?.getAttribute("aria-pressed"))
      .toBe("true");

    await act(async () => {
      deletion.resolve(Response.json({ ok: true }));
    });
    expect(screen.queryByText("asset-global.png")).toBeNull();
    expect(screen.getByRole("region", { name: "素材库面板" })
      .querySelector(".editor-asset-card[aria-pressed='true']")).toBeNull();
  });

  it("preserves a different asset selected in the new context after a global delete completes", async () => {
    const deletion = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded((call) => {
      if (call.url.includes("assetId=asset-a")) return deletion.promise;
      if (call.url.includes("/assets")) {
        return Response.json({
          ok: true,
          assets: [assetRecord("asset-a"), assetRecord("asset-b")],
        });
      }
      const city = call.url.includes("/SHENZHEN/") ? "SHENZHEN" : "SHANGHAI";
      return draftResponse("DESKTOP", city === "SHENZHEN" ? 5 : 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("asset-a.png");
    await userEvent.click(screen.getAllByRole("button", { name: "删除素材" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("asset-a.png");
    const assetBName = screen.getByText("asset-b.png");
    const assetBCard = assetBName.closest("li")?.querySelector("button");
    expect(assetBCard).toBeTruthy();
    await userEvent.click(assetBCard!);
    expect(assetBCard?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      deletion.resolve(Response.json({ ok: true }));
    });
    expect(screen.queryByText("asset-a.png")).toBeNull();
    expect(screen.getByText("asset-b.png")).toBeTruthy();
    expect(assetBCard?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not let an older asset load overwrite a successful upload in the same context", async () => {
    const lateAssets = deferred<Response>();
    await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "POST") {
        return Response.json({
          ok: true,
          asset: assetRecord("asset-uploaded"),
        }, { status: 201 });
      }
      if (call.url.includes("/assets")) return lateAssets.promise;
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    const input = screen.getByLabelText("上传 Logo 或图片");
    await userEvent.upload(
      input,
      new File([new Uint8Array([1])], "asset-uploaded.png", { type: "image/png" }),
    );
    const uploadedName = await screen.findByText("asset-uploaded.png");
    expect(uploadedName.closest("li")?.querySelector("button")?.getAttribute("aria-pressed"))
      .toBe("true");

    await act(async () => {
      lateAssets.resolve(Response.json({
        ok: true,
        assets: [assetRecord("asset-before-upload")],
      }));
    });
    expect(screen.getByText("asset-uploaded.png")).toBeTruthy();
    expect(screen.getByText("asset-before-upload.png")).toBeTruthy();
    expect(uploadedName.closest("li")?.querySelector("button")?.getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("removes both assets when two same-context deletes succeed out of order", async () => {
    const deleteFirst = deferred<Response>();
    const deleteSecond = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded((call) => {
      if (call.url.includes("assetId=asset-first")) return deleteFirst.promise;
      if (call.url.includes("assetId=asset-second")) return deleteSecond.promise;
      if (call.url.includes("/assets")) {
        return Response.json({
          ok: true,
          assets: [assetRecord("asset-first"), assetRecord("asset-second")],
        });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("asset-first.png");
    const deleteButtons = screen.getAllByRole("button", { name: "删除素材" });
    await userEvent.click(deleteButtons[0]!);
    await userEvent.click(deleteButtons[1]!);

    await act(async () => {
      deleteSecond.resolve(Response.json({ ok: true }));
    });
    expect(screen.queryByText("asset-second.png")).toBeNull();
    expect(screen.getByText("asset-first.png")).toBeTruthy();

    await act(async () => {
      deleteFirst.resolve(Response.json({ ok: true }));
    });
    expect(screen.queryByText("asset-first.png")).toBeNull();
    expect(screen.queryByText("asset-second.png")).toBeNull();
  });

  it("merges a successful upload while another same-context asset delete succeeds", async () => {
    const upload = deferred<Response>();
    const deletion = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "POST") return upload.promise;
      if (call.url.includes("assetId=asset-delete")) return deletion.promise;
      if (call.url.includes("/assets")) {
        return Response.json({ ok: true, assets: [assetRecord("asset-delete")] });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("asset-delete.png");
    await userEvent.upload(
      screen.getByLabelText("上传 Logo 或图片"),
      new File([new Uint8Array([1])], "asset-uploaded.png", { type: "image/png" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "删除素材" }));

    await act(async () => {
      deletion.resolve(Response.json({ ok: true }));
    });
    expect(screen.queryByText("asset-delete.png")).toBeNull();

    await act(async () => {
      upload.resolve(Response.json({
        ok: true,
        asset: assetRecord("asset-uploaded"),
      }, { status: 201 }));
    });
    expect(screen.getByText("asset-uploaded.png")).toBeTruthy();
    expect(screen.queryByText("asset-delete.png")).toBeNull();
  });

  it("creates all twelve strict component defaults at the visible canvas center and selects each one", async () => {
    await renderLoaded((call) => {
      if (call.url.includes("/assets")) {
        return Response.json({ ok: true, assets: [assetRecord()] });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    const creators = [
      ["文字", "TEXT"],
      ["矩形", "RECT"],
      ["圆形", "CIRCLE"],
      ["椭圆", "ELLIPSE"],
      ["圆角矩形", "ROUND_RECT"],
      ["三角形", "TRIANGLE"],
      ["线条", "LINE"],
      ["箭头", "ARROW"],
      ["图片", "IMAGE"],
      ["图标", "ICON"],
      ["按钮", "BUTTON"],
      ["标记点", "MARKER"],
    ] as const;

    for (const [label, type] of creators) {
      await userEvent.click(screen.getByRole("button", { name: label }));
      const current = parsedScene();
      const created = current.scene.elements.at(-1);
      expect(created?.type).toBe(type);
      expect(created?.x).toBeCloseTo((1_440 - (created?.width ?? 0)) / 2);
      expect(created?.y).toBeCloseTo((900 - (created?.height ?? 0)) / 2);
      expect(current.selection).toEqual([created?.id]);
      expect(() => portalSceneV1Schema.parse(current.scene)).not.toThrow();
    }
  });

  it("creates at the currently visible canvas center rather than the global canvas center", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord()] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    const stage = screen.getByLabelText("测试画布");
    const frame = stage.parentElement as HTMLDivElement;
    const scroller = frame.parentElement as HTMLDivElement;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: -200, y: -100, left: -200, top: -100, right: 520, bottom: 350,
      width: 720, height: 450, toJSON: () => ({}),
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
      width: 400, height: 300, toJSON: () => ({}),
    });

    await userEvent.click(screen.getByRole("button", { name: "矩形" }));
    expect(parsedScene().scene.elements[0]).toMatchObject({
      x: 670,
      y: 430,
    });
  });

  it("keeps the strict element limit and reports an actionable error", async () => {
    const full = {
      ...scene("DESKTOP", "#FFFFFF"),
      elements: Array.from({ length: 200 }, (_, index) => ({
        id: `limit-${index}`,
        type: "RECT" as const,
        name: `矩形 ${index + 1}`,
        x: index,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        opacity: 1,
        zIndex: index,
        locked: false,
        hidden: false,
        fillEnabled: true,
        fill: "#FFFFFF",
        lastFillColor: "#FFFFFF",
        stroke: null,
        strokeWidth: 0,
        dash: "SOLID",
        shadow: null,
      })),
    } satisfies PortalSceneV1;
    await renderLoaded(() => Response.json({
      ok: true,
      draft: { viewport: "DESKTOP", revision: 3, scene: full },
    }));

    await userEvent.click(screen.getByRole("button", { name: "文字" }));
    expect(parsedScene().scene.elements).toHaveLength(200);
    expect((await screen.findByRole("alert")).textContent).toContain("最多");
  });

  it("commits canonical type-specific properties and rejects unsafe button links", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord()] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));

    await userEvent.click(screen.getByRole("button", { name: "文字" }));
    fireEvent.change(screen.getByLabelText("文字内容"), { target: { value: "欢迎来到上海" } });
    fireEvent.change(screen.getByLabelText("字号"), { target: { value: "28" } });
    fireEvent.change(screen.getByLabelText("文字颜色"), { target: { value: "#112233" } });
    fireEvent.click(screen.getByLabelText("斜体"));
    fireEvent.click(screen.getByLabelText("下划线"));
    fireEvent.change(screen.getByLabelText("字距"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("文字背景"));
    fireEvent.change(screen.getByLabelText("文字背景色"), { target: { value: "#DDEEFF" } });
    fireEvent.click(screen.getByLabelText("文字链接"));
    fireEvent.change(screen.getByLabelText("文字链接地址"), { target: { value: "data:text/html,bad" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      action: { href: "/", target: "_self" },
    });
    fireEvent.change(screen.getByLabelText("文字链接地址"), { target: { value: "/employee/guides" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "TEXT",
      text: "欢迎来到上海",
      fontSize: 28,
      color: "#112233",
      italic: true,
      underline: true,
      letterSpacing: 3,
      backgroundColor: "#DDEEFF",
      action: { href: "/employee/guides", target: "_self" },
    });

    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    fireEvent.change(screen.getByLabelText("按钮文案"), { target: { value: "查看会议室" } });
    fireEvent.click(screen.getByLabelText("按钮边框"));
    fireEvent.change(screen.getByLabelText("边框宽度"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("边框线型"), { target: { value: "DASHED" } });
    fireEvent.click(screen.getByLabelText("按钮阴影"));
    fireEvent.change(screen.getByLabelText("阴影模糊"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "javascript:alert(1)" } });
    expect((await screen.findByRole("alert")).textContent).toContain("链接");
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "BUTTON",
      text: "查看会议室",
      action: { href: "/", target: "_self" },
      border: { width: 3, dash: "DASHED" },
      shadow: { blur: 14 },
    });
    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "https://example.com/rooms" } });
    fireEvent.change(screen.getByLabelText("打开方式"), { target: { value: "_blank" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      action: { href: "https://example.com/rooms", target: "_blank" },
    });
    expect(() => portalSceneV1Schema.parse(parsedScene().scene)).not.toThrow();
  });

  it("keeps button href drafts synchronized when switching directly between buttons", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord()] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "/first" } });
    const first = parsedScene().scene.elements.at(-1)!;
    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    fireEvent.change(screen.getByLabelText("链接地址"), { target: { value: "/second" } });
    const second = parsedScene().scene.elements.at(-1)!;
    await userEvent.click(screen.getByRole("button", { name: "图层" }));

    fireEvent.click(screen.getByTestId(`layer-${first.id}`).querySelector("button")!);
    expect((screen.getByLabelText("链接地址") as HTMLInputElement).value).toBe("/first");
    fireEvent.click(screen.getByTestId(`layer-${second.id}`).querySelector("button")!);
    expect((screen.getByLabelText("链接地址") as HTMLInputElement).value).toBe("/second");
  });

  it("creates IMAGE only from a real inspected asset and saves that exact reference", async () => {
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets")) {
        return Response.json({ ok: true, assets: [assetRecord("asset-saveable")] });
      }
      if (call.method === "PATCH") {
        const body = JSON.parse(String(call.body)) as { scene: PortalSceneV1 };
        return Response.json({
          ok: true,
          draft: { viewport: "DESKTOP", revision: 4, scene: body.scene },
        });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(parsedScene().scene.elements[0]).toMatchObject({
      type: "IMAGE",
      assetId: "asset-saveable",
    });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("桌面草稿已保存");
    expect(bodyOf(calls.find((call) => call.method === "PATCH"))).toMatchObject({
      scene: { elements: [{ type: "IMAGE", assetId: "asset-saveable" }] },
    });
  });

  it("uploads a local image from Add Components and immediately adds and selects it on the canvas", async () => {
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "POST") {
        return Response.json({
          ok: true,
          asset: assetRecord("direct-upload"),
        }, { status: 201 });
      }
      if (call.url.includes("/assets")) return Response.json({ ok: true, assets: [] });
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    const input = screen.getByLabelText("上传本地图片并添加到画布");
    const file = new File([new Uint8Array([1, 2, 3])], "floor-plan.jpg", { type: "image/jpeg" });
    await userEvent.upload(input, file);

    await waitFor(() => expect(calls.some((call) =>
      call.method === "POST"
      && call.body instanceof FormData
      && call.body.get("category") === "IMAGE"
      && call.body.get("file") === file
    )).toBe(true));
    await waitFor(() => expect(parsedScene().scene.elements).toHaveLength(1));
    const element = parsedScene().scene.elements[0]!;
    expect(element).toMatchObject({
      type: "IMAGE",
      assetId: "direct-upload",
      width: 320,
      height: 240,
      x: 560,
      y: 330,
      lockAspectRatio: true,
    });
    expect(parsedScene().selection).toEqual([element.id]);
    expect(screen.getByRole("heading", { name: "属性" })).toBeTruthy();
  });

  it("isolates image crop previews from workflow mutations and persists only the applied crop", async () => {
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets")) {
        return Response.json({ ok: true, assets: [assetRecord("asset-crop")] });
      }
      if (call.method === "PATCH") {
        const body = JSON.parse(String(call.body)) as { scene: PortalSceneV1 };
        return Response.json({
          ok: true,
          draft: { viewport: "DESKTOP", revision: 4, scene: body.scene },
        });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    const baseline = parsedScene().scene.elements[0];
    expect(baseline).toMatchObject({
      type: "IMAGE",
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });

    const cropTrigger = screen.getByRole("button", { name: "裁剪图片" });
    await userEvent.click(cropTrigger);
    expect(screen.getByRole("button", { name: "裁剪图片" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存并发布" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "深圳" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "手机" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("替代文字").matches(":disabled")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "测试预览裁剪" }));
    await userEvent.click(screen.getByRole("button", { name: "测试预览裁剪" }));
    expect(parsedScene().scene.elements[0]).toEqual(baseline);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "测试应用裁剪" }));
    expect(document.activeElement).toBe(cropTrigger);
    expect(parsedScene().history).toBe(2);
    expect(parsedScene().scene.elements[0]).toMatchObject({
      crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("桌面草稿已保存");
    const patch = bodyOf(calls.find((call) => call.method === "PATCH"));
    expect(patch.scene.elements[0]).toMatchObject({
      crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    });
    expect(JSON.stringify(patch)).not.toMatch(/cropTarget|transientPreview|cropSession/u);

    await userEvent.click(screen.getByRole("button", { name: "裁剪图片" }));
    await userEvent.click(screen.getByRole("button", { name: "测试预览裁剪" }));
    await userEvent.click(screen.getByRole("button", { name: "测试取消裁剪" }));
    expect(document.activeElement).toBe(cropTrigger);
    expect(parsedScene().scene.elements[0]).toMatchObject({
      crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    });
    expect(parsedScene().dirty).toBe(false);
  });

  it.each(["保存", "保存并发布"])(
    "prevents entering crop mode while %s is pending",
    async (actionName) => {
      const lateMutation = deferred<Response>();
      await renderLoaded((call) => {
        if (call.url.includes("/assets")) {
          return Response.json({ ok: true, assets: [assetRecord("asset-busy")] });
        }
        if (call.method === "PATCH") return lateMutation.promise;
        if (call.method === "POST" && call.url.endsWith("/publish")) {
          return Response.json({ ok: true, city: "SHANGHAI", version: 12 }, { status: 201 });
        }
        if (call.url.includes("viewport=MOBILE")) {
          return draftResponse("MOBILE", 7, "#FFFFFF");
        }
        return draftResponse("DESKTOP", 3, "#FFFFFF");
      });
      if (actionName === "保存并发布") {
        vi.spyOn(window, "confirm").mockReturnValue(true);
      }
      await userEvent.click(screen.getByRole("button", { name: "图片" }));
      const cropButton = screen.getByRole("button", { name: "裁剪图片" }) as HTMLButtonElement;
      await userEvent.click(screen.getByRole("button", { name: actionName }));

      await waitFor(() => expect(cropButton.disabled).toBe(true));
      fireEvent.click(cropButton);
      expect(screen.queryByRole("button", { name: "测试预览裁剪" })).toBeNull();

      await act(async () => {
        lateMutation.resolve(draftResponse("DESKTOP", 4, "#FFFFFF"));
      });
      await waitFor(() => {
        expect((screen.getByRole("button", { name: actionName }) as HTMLButtonElement).disabled)
          .toBe(false);
      });
    },
  );

  it("rejects a hidden image as a new crop target", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord("asset-hidden")] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "可见" }));

    const cropButton = screen.getByRole("button", { name: "裁剪图片" }) as HTMLButtonElement;
    expect(cropButton.disabled).toBe(true);
    fireEvent.click(cropButton);
    expect(screen.queryByRole("button", { name: "测试预览裁剪" })).toBeNull();
  });

  it("automatically cancels a crop preview when the selected target changes", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord("asset-cancel")] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    const baseline = parsedScene();
    await userEvent.click(screen.getByRole("button", { name: "裁剪图片" }));
    await userEvent.click(screen.getByRole("button", { name: "测试预览裁剪" }));
    await userEvent.click(screen.getByRole("button", { name: "测试切换裁剪目标" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "测试预览裁剪" })).toBeNull();
    });
    expect(parsedScene().scene).toEqual(baseline.scene);
    expect(parsedScene().history).toBe(baseline.history);
    expect(parsedScene().dirty).toBe(baseline.dirty);
  });

  it.each([
    ["测试更换裁剪素材", { assetId: "asset-replaced" }],
    ["测试更改裁剪显示方式", { fitMode: "CONTAIN" }],
    ["测试锁定裁剪目标", { locked: true }],
    ["测试隐藏裁剪目标", { hidden: true }],
  ])("automatically exits crop mode when target invariants change via %s", async (action, expected) => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord("asset-invariant")] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    await userEvent.click(screen.getByRole("button", { name: "裁剪图片" }));
    await userEvent.click(screen.getByRole("button", { name: "测试预览裁剪" }));
    await userEvent.click(screen.getByRole("button", { name: action }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "测试预览裁剪" })).toBeNull();
    });
    expect(parsedScene().scene.elements[0]).toMatchObject(expected);
    expect(parsedScene().scene.elements[0]).toMatchObject({
      crop: { x: 0, y: 0, width: 1, height: 1 },
    });
  });

  it("does not create IMAGE when the real asset library has no inspected image", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(parsedScene().scene.elements).toHaveLength(0);
    expect((await screen.findByRole("alert")).textContent).toContain("先");
  });

  it("commits the key controls for shape, arrow, image, icon and marker groups", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [assetRecord()] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));

    await userEvent.click(screen.getByRole("button", { name: "圆角矩形" }));
    fireEvent.change(screen.getByLabelText("填充颜色"), { target: { value: "#334455" } });
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("圆角"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("线型"), { target: { value: "DOTTED" } });
    fireEvent.click(screen.getByLabelText("形状阴影"));
    fireEvent.change(screen.getByLabelText("阴影水平偏移"), { target: { value: "5" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "ROUND_RECT",
      fillEnabled: true,
      fill: "#334455",
      lastFillColor: "#334455",
      strokeWidth: 6,
      cornerRadius: 24,
      dash: "DOTTED",
      shadow: { offsetX: 5 },
    });

    await userEvent.click(screen.getByRole("button", { name: "箭头" }));
    fireEvent.change(screen.getByLabelText("线条颜色"), { target: { value: "#556677" } });
    fireEvent.change(screen.getByLabelText("线宽"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("箭头长度"), { target: { value: "22" } });
    fireEvent.change(screen.getByLabelText("线型"), { target: { value: "DASHED" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "ARROW",
      stroke: "#556677",
      strokeWidth: 5,
      pointerLength: 22,
      dash: "DASHED",
    });

    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    fireEvent.change(screen.getByLabelText("替代文字"), { target: { value: "前台地图" } });
    fireEvent.change(screen.getByLabelText("图片显示方式"), { target: { value: "CONTAIN" } });
    fireEvent.change(screen.getByLabelText("裁剪宽度"), { target: { value: "0.8" } });
    fireEvent.change(screen.getByLabelText("裁剪 X"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByLabelText("图片圆角"), { target: { value: "18" } });
    fireEvent.click(screen.getByLabelText("图片链接"));
    fireEvent.change(screen.getByLabelText("图片链接地址"), { target: { value: "https://example.com/map" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "IMAGE",
      altText: "前台地图",
      fitMode: "CONTAIN",
      crop: { x: 0.1 },
      cornerRadius: 18,
      action: { href: "https://example.com/map", target: "_self" },
    });

    await userEvent.click(screen.getByRole("button", { name: "图标" }));
    fireEvent.change(screen.getByLabelText("系统图标"), { target: { value: "Wifi" } });
    fireEvent.change(screen.getByLabelText("图标颜色"), { target: { value: "#778899" } });
    fireEvent.click(screen.getByLabelText("图标链接"));
    fireEvent.change(screen.getByLabelText("图标链接地址"), { target: { value: "/wifi" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "ICON",
      iconName: "Wifi",
      color: "#778899",
      action: { href: "/wifi", target: "_self" },
    });

    await userEvent.click(screen.getByRole("button", { name: "标记点" }));
    fireEvent.change(screen.getByLabelText("标记文案"), { target: { value: "前台" } });
    fireEvent.change(screen.getByLabelText("标记图标"), { target: { value: "Info" } });
    fireEvent.change(screen.getByLabelText("标记标题"), { target: { value: "上海前台" } });
    fireEvent.change(screen.getByLabelText("标记说明"), { target: { value: "访客请在这里登记" } });
    fireEvent.change(screen.getByLabelText("标记前景色"), { target: { value: "#FFFFFF" } });
    fireEvent.change(screen.getByLabelText("标记背景色"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "100" } });
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({
      type: "MARKER",
      text: "前台",
      iconName: "Info",
      title: "上海前台",
      description: "访客请在这里登记",
      backgroundColor: "#112233",
      x: 100,
    });
    expect(() => portalSceneV1Schema.parse(parsedScene().scene)).not.toThrow();
  });

  it("edits page background and image assets through the real city asset endpoint", async () => {
    const asset = {
      id: "asset-1",
      originalName: "welcome.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      createdAt: "2026-07-26T00:00:00.000Z",
      category: "BACKGROUND",
      width: 1625,
      height: 6375,
      inspectionStatus: "VALID",
      searchText: "welcome.png image/png background 1440x900",
      references: {
        draft: [{ city: "SHANGHAI", viewport: "DESKTOP", elementId: "__background__" }],
        current: [{ city: "SHENZHEN", viewport: "MOBILE", version: 2, elementId: "hero" }],
        history: [],
      },
      referenceCounts: { draft: 1, current: 1, history: 0 },
      unused: false,
      url: "/api/files/asset-1",
    };
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets")) {
        if (call.method === "POST") {
          return Response.json({ ok: true, asset: { ...asset, id: "asset-upload" } }, { status: 201 });
        }
        return Response.json({ ok: true, assets: [asset] });
      }
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });

    await userEvent.click(screen.getByRole("button", { name: "页面设置" }));
    await screen.findByText("welcome.png");
    fireEvent.change(screen.getByLabelText("背景色"), { target: { value: "#ABCDEF" } });
    await userEvent.click(screen.getByRole("radio", { name: "完整显示" }));
    fireEvent.change(screen.getByLabelText("背景 X 位置"), { target: { value: "25" } });
    await userEvent.click(screen.getByRole("button", { name: "设为背景" }));
    expect(parsedScene().scene.background).toMatchObject({
      assetId: "asset-1",
      naturalWidth: 1625,
      naturalHeight: 6375,
      backgroundColor: "#ABCDEF",
      fitMode: "CONTAIN",
      positionX: 25,
    });
    await userEvent.click(screen.getByRole("radio", { name: "长图完整显示（高度自适应）" }));
    expect(parsedScene().scene.background.fitMode).toBe("AUTO_HEIGHT");
    expect(parsedScene().scene.canvas?.logicalHeight).toBeCloseTo(1_440 * 6_375 / 1_625, 8);
    expect((screen.getByLabelText("背景 X 位置") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("背景 Y 位置") as HTMLInputElement).disabled).toBe(true);

    const upload = screen.getByLabelText("上传背景图片");
    const file = new File([new Uint8Array([1, 2, 3])], "new.png", { type: "image/png" });
    await userEvent.upload(upload, file);
    await waitFor(() => expect(calls.some((call) =>
      call.method === "POST"
      && call.body instanceof FormData
      && call.body.get("category") === "BACKGROUND"
      && call.body.get("file") === file
    )).toBe(true));
    await waitFor(() => expect(parsedScene().scene.background.assetId).toBe("asset-upload"));
  });

  it("adopts successful LOGO uploads and exposes upload API errors without data URLs", async () => {
    let uploadCount = 0;
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "POST") {
        uploadCount += 1;
        return uploadCount === 1
          ? Response.json({ ok: true, asset: assetRecord("logo-upload") }, { status: 201 })
          : Response.json({ ok: false, message: "图片结构校验失败" }, { status: 400 });
      }
      if (call.url.includes("/assets")) return Response.json({ ok: true, assets: [] });
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await screen.findByText("没有符合条件的素材。");
    fireEvent.change(screen.getByLabelText("上传素材分类"), { target: { value: "LOGO" } });
    const input = screen.getByLabelText("上传 Logo 或图片");
    const logo = new File([new Uint8Array([1])], "logo.png", { type: "image/png" });
    await userEvent.upload(input, logo);
    expect(await screen.findByText("logo-upload.png")).toBeTruthy();
    expect((calls.find((call) => call.method === "POST")?.body as FormData).get("category")).toBe("LOGO");
    expect(document.querySelector("img")?.getAttribute("src")).not.toContain("data:");

    const broken = new File([new Uint8Array([2])], "broken.png", { type: "image/png" });
    await userEvent.upload(input, broken);
    expect((await screen.findByRole("alert")).textContent).toContain("结构校验失败");
  });

  it("shows real asset references, replaces an image, and exposes referenced deletion errors", async () => {
    const asset = {
      id: "asset-2",
      originalName: "map.webp",
      mimeType: "image/webp",
      sizeBytes: 4096,
      createdAt: "2026-07-26T00:00:00.000Z",
      category: "IMAGE",
      width: 800,
      height: 600,
      inspectionStatus: "VALID",
      searchText: "map.webp image/webp image 800x600",
      references: {
        draft: [{ city: "XIAN", viewport: "DESKTOP", elementId: "map" }],
        current: [{ city: "CHANGSHA", viewport: "MOBILE", version: 8, elementId: "map" }],
        history: [{ city: "SHANGHAI", viewport: "DESKTOP", version: 1, elementId: "old-map" }],
      },
      referenceCounts: { draft: 1, current: 1, history: 1 },
      unused: false,
      url: "/api/files/asset-2",
    };
    const calls = await renderLoaded((call) => {
      if (call.url.includes("/assets") && call.method === "DELETE") {
        return Response.json({ ok: false, message: "该素材仍被草稿或发布版本引用，不能删除" }, { status: 409 });
      }
      if (call.url.includes("/assets")) return Response.json({ ok: true, assets: [asset] });
      return draftResponse("DESKTOP", 3, "#FFFFFF");
    });
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    expect((await screen.findAllByText("map.webp")).length).toBeGreaterThan(0);
    expect(screen.getByText(/西安.*桌面.*草稿/)).toBeTruthy();
    expect(screen.getByText(/长沙.*手机.*当前发布.*v8/)).toBeTruthy();
    expect(screen.getByText(/上海.*桌面.*历史发布.*v1/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "删除素材" }));
    expect((await screen.findByRole("alert")).textContent).toContain("仍被");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "添加组件" }));
    await userEvent.click(screen.getByRole("button", { name: "图片" }));
    await userEvent.click(screen.getByRole("button", { name: "素材库" }));
    await userEvent.click(screen.getByRole("button", { name: "选择或替换" }));
    expect(parsedScene().scene.elements.at(-1)).toMatchObject({ type: "IMAGE", assetId: "asset-2" });
    await userEvent.click(screen.getByRole("button", { name: "删除素材" }));
    expect((await screen.findByRole("alert")).textContent).toContain("仍被");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("supports layer selection, hidden selection, locking, real drag reorder, and keyboard history", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "矩形" }));
    await userEvent.click(screen.getByRole("button", { name: "文字" }));
    const [rect, text] = parsedScene().scene.elements;

    await userEvent.click(screen.getByRole("button", { name: "图层" }));
    await userEvent.click(screen.getByRole("button", { name: `隐藏 ${text!.name}` }));
    await userEvent.click(screen.getByRole("button", { name: `选择 ${text!.name}` }));
    expect(parsedScene().selection).toEqual([text!.id]);
    await userEvent.click(screen.getByRole("button", { name: `锁定 ${text!.name}` }));
    fireEvent.change(screen.getByLabelText("图层名称"), { target: { value: "锁定后不可改" } });
    expect(parsedScene().scene.elements.find(({ id }) => id === text!.id)?.name).toBe(text!.name);

    await userEvent.click(screen.getByRole("button", { name: `解锁 ${text!.name}` }));
    const rectRow = screen.getByTestId(`layer-${rect!.id}`);
    const textRow = screen.getByTestId(`layer-${text!.id}`);
    fireEvent.dragStart(textRow);
    fireEvent.dragOver(rectRow);
    fireEvent.drop(rectRow);
    expect(parsedScene().scene.elements.find(({ id }) => id === text!.id)?.zIndex).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: `选择 ${text!.name}` }));
    const beforeX = parsedScene().scene.elements.find(({ id }) => id === text!.id)!.x;
    const shortcutScope = screen.getByLabelText("画布工作区");
    shortcutScope.focus();
    fireEvent.keyDown(shortcutScope, { key: "ArrowRight", shiftKey: true });
    expect(parsedScene().scene.elements.find(({ id }) => id === text!.id)?.x).toBe(beforeX + 10);
    expect(parsedScene().history).toBeGreaterThan(2);

    const search = screen.getByLabelText("图层名称");
    search.focus();
    fireEvent.keyDown(search, { key: "Delete" });
    expect(parsedScene().scene.elements).toHaveLength(2);

    const stageButton = screen.getByRole("button", { name: "修改测试场景" });
    stageButton.focus();
    fireEvent.keyDown(stageButton, { key: "Delete" });
    expect(parsedScene().scene.elements).toHaveLength(2);
  });

  it("operates undo, redo, duplicate, snap, zoom and fit controls", async () => {
    await renderLoaded((call) => call.url.includes("/assets")
      ? Response.json({ ok: true, assets: [] })
      : draftResponse("DESKTOP", 3, "#FFFFFF"));
    await userEvent.click(screen.getByRole("button", { name: "矩形" }));
    const shortcutScope = screen.getByLabelText("画布工作区");
    shortcutScope.focus();
    fireEvent.keyDown(shortcutScope, { key: "d", metaKey: true });
    expect(parsedScene().scene.elements).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(parsedScene().scene.elements).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(parsedScene().scene.elements).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "图层" }));
    await userEvent.click(screen.getByRole("button", { name: "选择 矩形" }));
    shortcutScope.focus();
    fireEvent.keyDown(shortcutScope, { key: "c", metaKey: true });
    fireEvent.keyDown(shortcutScope, { key: "v", metaKey: true });
    expect(parsedScene().scene.elements).toHaveLength(3);
    fireEvent.keyDown(shortcutScope, { key: "z", metaKey: true });
    expect(parsedScene().scene.elements).toHaveLength(2);
    fireEvent.keyDown(shortcutScope, { key: "z", metaKey: true, shiftKey: true });
    expect(parsedScene().scene.elements).toHaveLength(3);
    fireEvent.keyDown(shortcutScope, { key: "z", ctrlKey: true });
    fireEvent.keyDown(shortcutScope, { key: "y", ctrlKey: true });
    expect(parsedScene().scene.elements).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "关闭吸附" }));
    expect(parsedScene().snapEnabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(parsedScene().zoom).toBeGreaterThan(0.5);
    await userEvent.click(screen.getByRole("button", { name: "缩小" }));
    await userEvent.click(screen.getByRole("button", { name: "适应窗口" }));
    expect(screen.getByLabelText("缩放比例").textContent).toContain("%");
  });

  it("saves the desktop draft, copies it to mobile with both revisions, and loads the mobile canvas", async () => {
    let mobileGetCount = 0;
    const calls = await renderLoaded((call) => {
      if (call.method === "PATCH") return draftResponse("DESKTOP", 4, "#123456");
      if (call.method === "POST" && call.url.endsWith("/draft")) {
        return draftResponse("MOBILE", 2, "#123456", true);
      }
      if (call.method === "GET" && call.url.includes("viewport=MOBILE")) {
        mobileGetCount += 1;
        return mobileGetCount === 1
          ? Response.json({ ok: true, draft: null })
          : draftResponse("MOBILE", 2, "#123456", true);
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "修改测试场景" }));
    await userEvent.click(screen.getByRole("button", { name: "复制桌面到手机" }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      viewport: "MOBILE",
      revision: 2,
      requiresMobileReview: true,
      color: "#123456",
    }));
    expect(await screen.findByText(/已复制并约束到手机画布/)).toBeTruthy();
    const copy = calls.find((call) =>
      call.method === "POST" && call.url.endsWith("/draft")
      && bodyOf(call).action === "COPY_DESKTOP_TO_MOBILE");
    expect(bodyOf(copy)).toEqual({
      action: "COPY_DESKTOP_TO_MOBILE",
      revisions: { desktop: 4, mobile: 0 },
    });
  });

  it("lists publication history and restores a selected version into the current draft", async () => {
    const calls = await renderLoaded((call) => {
      if (call.url.endsWith("/history")) {
        return Response.json({
          ok: true,
          history: [{
            version: 2,
            createdAt: "2026-07-25T08:00:00.000Z",
            publishedBySnapshot: { name: "端到端管理员" },
          }],
        });
      }
      if (call.url.endsWith("/restore") && call.method === "POST") {
        return draftResponse("DESKTOP", 5, "#112233");
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByRole("dialog", { name: "发布历史" })).toBeTruthy();
    expect(screen.getByText("版本 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "恢复版本 2" }));
    await waitFor(() => expect(parsedScene()).toMatchObject({
      revision: 5,
      color: "#112233",
      dirty: false,
    }));
    expect(screen.getByText("版本 2 已恢复为新草稿")).toBeTruthy();
    const restore = calls.find((call) => call.url.endsWith("/restore"));
    expect(bodyOf(restore)).toEqual({
      viewport: "DESKTOP",
      version: 2,
      revision: 3,
    });
  });

  it("modal header close invalidates in-flight history and blocks late success/error leaks", async () => {
    let historyResolve: ((value: Response) => void) | null = null;
    let historyReject: ((reason?: unknown) => void) | null = null;
    await renderLoaded((call) => {
      if (call.url.endsWith("/history")) {
        return new Promise<Response>((resolve, reject) => {
          historyResolve = resolve;
          historyReject = reject;
        });
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });

    // Open via actual toolbar UI.
    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    const dialog = await screen.findByRole("dialog", { name: "发布历史" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByRole("status").textContent).toMatch(/正在加载历史/);
    expect(historyResolve).not.toBeNull();

    // Close via modal/header close button (not toolbar toggle).
    await userEvent.click(within(dialog).getByRole("button", { name: "关闭发布历史" }));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();
    expect(screen.queryByText(/正在加载历史/)).toBeNull();

    // Late success must not reopen list/loading state.
    historyResolve!(Response.json({
      ok: true,
      history: [{
        version: 3,
        createdAt: "2026-07-25T09:00:00.000Z",
        publishedBySnapshot: { name: "陈旧模态" },
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();
    expect(screen.queryByText("版本 3")).toBeNull();
    expect(screen.queryByText("陈旧模态")).toBeNull();
    expect(screen.queryByText(/正在加载历史/)).toBeNull();

    // Re-open a fresh deferred request, close via header again, then late error.
    historyResolve = null;
    historyReject = null;
    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    const dialogAgain = await screen.findByRole("dialog", { name: "发布历史" });
    expect(historyReject).not.toBeNull();
    await userEvent.click(within(dialogAgain).getByRole("button", { name: "关闭发布历史" }));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();

    historyReject!(new Error("modal-close stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();
    expect(screen.queryByText(/历史版本加载失败|modal-close stale/)).toBeNull();
    expect(screen.queryByText(/正在加载历史/)).toBeNull();
  });

  it("ignores late same-city history success after close and reopen", async () => {
    let openCount = 0;
    let firstHistoryResolve: ((value: Response) => void) | null = null;
    await renderLoaded((call) => {
      if (call.url.endsWith("/history")) {
        openCount += 1;
        if (openCount === 1) {
          return new Promise<Response>((resolve) => {
            firstHistoryResolve = resolve;
          });
        }
        return Response.json({
          ok: true,
          history: [{
            version: 7,
            createdAt: "2026-07-26T10:00:00.000Z",
            publishedBySnapshot: { name: "二次打开" },
          }],
        });
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByRole("dialog", { name: "发布历史" })).toBeTruthy();
    expect(firstHistoryResolve).not.toBeNull();

    // Close without leaving city — request id must invalidate the in-flight open.
    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByText("版本 7")).toBeTruthy();
    expect(screen.queryByText("版本 2")).toBeNull();

    // Late success from the first open must not overwrite the second open's entries.
    firstHistoryResolve!(Response.json({
      ok: true,
      history: [{
        version: 2,
        createdAt: "2026-07-25T08:00:00.000Z",
        publishedBySnapshot: { name: "陈旧打开" },
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByText("版本 7")).toBeTruthy();
    expect(screen.queryByText("版本 2")).toBeNull();
    expect(screen.queryByText("陈旧打开")).toBeNull();
  });

  it("ignores late same-city history error after close and reopen", async () => {
    let openCount = 0;
    let firstHistoryReject: ((reason?: unknown) => void) | null = null;
    await renderLoaded((call) => {
      if (call.url.endsWith("/history")) {
        openCount += 1;
        if (openCount === 1) {
          return new Promise<Response>((_resolve, reject) => {
            firstHistoryReject = reject;
          });
        }
        return Response.json({
          ok: true,
          history: [{
            version: 8,
            createdAt: "2026-07-26T11:00:00.000Z",
            publishedBySnapshot: { name: "稳定打开" },
          }],
        });
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByRole("dialog", { name: "发布历史" })).toBeTruthy();
    expect(firstHistoryReject).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByText("版本 8")).toBeTruthy();

    // Late network/error from the first open must not clear the second open.
    firstHistoryReject!(new Error("stale history network failure"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByText("版本 8")).toBeTruthy();
    expect(screen.queryByText(/历史版本加载失败|stale history/)).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复版本 8" })).toBeTruthy();
  });

  it("clears Shanghai history when switching to Shenzhen and ignores stale history errors", async () => {
    let shanghaiHistoryResolvers: Array<(value: Response) => void> = [];
    const calls = await renderLoaded((call) => {
      if (call.url.endsWith("/history") && call.url.includes("/SHANGHAI/")) {
        return new Promise<Response>((resolve) => {
          shanghaiHistoryResolvers.push(resolve);
        });
      }
      if (call.url.endsWith("/history") && call.url.includes("/SHENZHEN/")) {
        return Response.json({
          ok: true,
          history: [{
            version: 9,
            createdAt: "2026-07-26T08:00:00.000Z",
            publishedBySnapshot: { name: "深圳管理员" },
          }],
        });
      }
      if (call.url.includes("/SHENZHEN/")) {
        return draftResponse("DESKTOP", 5, "#00AA00");
      }
      return draftResponse("DESKTOP", 3, "#AAAAAA");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByRole("dialog", { name: "发布历史" })).toBeTruthy();
    // Shanghai history still in-flight.
    expect(shanghaiHistoryResolvers.length).toBeGreaterThan(0);

    // Switch city while history is loading: panel must close and not show Shanghai entries.
    await userEvent.click(screen.getByRole("button", { name: "深圳" }));
    await waitFor(() => expect(parsedScene().city).toBe("SHENZHEN"));
    expect(screen.queryByRole("dialog", { name: "发布历史" })).toBeNull();
    expect(screen.queryByText("版本 2")).toBeNull();

    // Resolve stale Shanghai history: must not reopen / inject Shanghai entries.
    for (const resolve of shanghaiHistoryResolvers) {
      resolve(Response.json({
        ok: true,
        history: [{
          version: 2,
          createdAt: "2026-07-25T08:00:00.000Z",
          publishedBySnapshot: { name: "上海管理员" },
        }],
      }));
    }
    shanghaiHistoryResolvers = [];
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("版本 2")).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复版本 2" })).toBeNull();

    // Fresh Shenzhen history is city-scoped.
    await userEvent.click(screen.getByRole("button", { name: "历史" }));
    expect(await screen.findByText("版本 9")).toBeTruthy();
    expect(screen.queryByText("版本 2")).toBeNull();
    expect(calls.some((call) => call.url.includes("/SHENZHEN/") && call.url.endsWith("/history"))).toBe(true);
  });

  it("opens the employee-style draft preview without publishing", async () => {
    await renderLoaded(() => draftResponse("DESKTOP", 3, "#ABCDEF"));
    await userEvent.click(screen.getByRole("button", { name: "预览" }));
    const preview = screen.getByRole("dialog", { name: "员工预览" });
    expect(preview).toBeTruthy();
    expect(screen.getByText("预览（未发布）")).toBeTruthy();
    await userEvent.click(within(preview).getByRole("button", { name: "退出预览" }));
    expect(screen.queryByRole("dialog", { name: "员工预览" })).toBeNull();
  });
});
