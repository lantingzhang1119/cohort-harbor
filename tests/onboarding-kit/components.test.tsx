// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialAdmin } from "@/features/onboarding-kit/components/material-admin";
import { MaterialList } from "@/features/onboarding-kit/components/material-list";

const items = [
  { id: "m1", title: "入职手册", category: "入职必读", description: "第一天阅读", updatedAt: "2026-07-22T00:00:00.000Z", downloadUrl: "/api/onboarding-kit/m1/download", currentVersion: { id: "v1", versionNumber: 1, displayName: "手册.pdf", extension: ".pdf", mimeType: "application/pdf", sizeBytes: 2048, createdAt: "2026-07-22T00:00:00.000Z" } },
  { id: "m2", title: "工具清单", category: "工具资料", description: null, updatedAt: "2026-07-22T00:00:00.000Z", downloadUrl: "/api/onboarding-kit/m2/download", currentVersion: { id: "v2", versionNumber: 2, displayName: "清单.xlsx", extension: ".xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 4096, createdAt: "2026-07-22T00:00:00.000Z" } },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("onboarding-kit UI", () => {
  it("keeps metadata editing, file replacement and version history as distinct admin actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, materials: [{ ...items[0], status: "PUBLISHED", sortOrder: 0, versions: [items[0].currentVersion] }] }))));
    render(<MaterialAdmin />);
    expect(await screen.findByText("入职手册")).toBeTruthy();
    expect(screen.getByText("修改资料信息")).toBeTruthy();
    expect(screen.getByText("替换文件（新增版本）")).toBeTruthy();
    expect(screen.getByText("版本历史")).toBeTruthy();
    expect(screen.getByRole("link", { name: /下载 v1/ }).getAttribute("href")).toContain("versionId=v1");
  });

  it("offers delete confirmation for version or whole pack and recycle-bin restore", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/onboarding-kit" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({
          ok: true,
          materials: [{
            ...items[0],
            status: "PUBLISHED",
            sortOrder: 0,
            currentVersion: items[0].currentVersion,
            versions: [
              { ...items[0].currentVersion!, id: "v2", versionNumber: 2, displayName: "手册-v2.pdf" },
              items[0].currentVersion,
            ],
          }],
        }));
      }
      if (url === "/api/admin/onboarding-kit/recycle-bin") {
        return new Response(JSON.stringify({
          ok: true,
          materials: [{ id: "recycled", title: "回收资料", category: "入职必读", deletedAt: new Date().toISOString(), statusBeforeDelete: "PUBLISHED", versions: [] }],
          versions: [{
            id: "recycled-version",
            versionNumber: 1,
            displayName: "旧版手册.pdf",
            originalName: "旧版手册.pdf",
            extension: ".pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            createdAt: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            material: { id: "active-material", title: "仍有效资料", category: "入职必读", status: "PUBLISHED" },
          }],
        }));
      }
      if (url.includes("/recycle") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, publishOutcome: "ROLLED_BACK", rolledBackToVersionNumber: 1 }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MaterialAdmin />);
    expect(await screen.findByText("入职手册")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除资料确认" });
    expect(within(dialog).getByText(/入职手册/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /删除整份资料/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /删除整份资料/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/onboarding-kit/m1/recycle"),
      expect.objectContaining({ method: "POST" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: /回收站/ }));
    const recycleDialog = await screen.findByRole("dialog", { name: "入职资料回收站" });
    expect(within(recycleDialog).getByText("回收资料")).toBeTruthy();
    expect(within(recycleDialog).getByText(/仍有效资料 · v1/)).toBeTruthy();
    fireEvent.click(within(recycleDialog).getByRole("button", { name: "恢复版本 v1" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/onboarding-kit/active-material/versions/recycled-version/recycle/restore"),
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(within(recycleDialog).getByRole("button", { name: /恢复整份/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/onboarding-kit/recycled/recycle/restore"),
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("supports employee filtering, selecting current results and clearing selection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, items }))));
    render(<MaterialList />);
    expect(await screen.findByText("入职手册")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("资料分类"), { target: { value: "工具资料" } });
    expect(screen.queryByText("入职手册")).toBeNull();
    expect(screen.getByText("工具清单")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择当前筛选结果" }));
    expect(screen.getByRole("button", { name: /下载已选 1 项/ }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /下载已选 0 项/ }).hasAttribute("disabled")).toBe(true));
  });

  it("provides preview link pointing to /onboarding-kit/{id}/preview while retaining single download and batch download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, items }))));
    render(<MaterialList />);
    expect(await screen.findByText("入职手册")).toBeTruthy();

    const viewLink = screen.getAllByRole("link", { name: "查看" })[0]!;
    expect(viewLink.getAttribute("href")).toBe("/onboarding-kit/m1/preview");

    const downloadLink = screen.getAllByRole("link", { name: "下载" })[0]!;
    expect(downloadLink.getAttribute("href")).toBe("/api/onboarding-kit/m1/download");
    expect(downloadLink.hasAttribute("download")).toBe(true);
  });
});
