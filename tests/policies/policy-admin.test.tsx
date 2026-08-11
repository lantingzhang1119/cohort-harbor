// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PolicyAdmin } from "@/features/policies/components/policy-admin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("policy admin", () => {
  it("uses company-wide scope and only enables publishing for a ready preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      previewEnvironment: { available: true, chineseFontAvailable: true, version: "LibreOffice fixture" },
      policies: [
        { id: "ready", name: "可发布制度", category: "通用", status: "DRAFT", sortOrder: 0, versions: [{ id: "v1", versionNumber: "1.0", effectiveDate: new Date().toISOString(), previewStatus: "READY", previewFormat: "PDF", previewError: null }] },
        { id: "failed", name: "失败制度", category: "通用", status: "DRAFT", sortOrder: 1, versions: [{ id: "v2", versionNumber: "1.0", effectiveDate: new Date().toISOString(), previewStatus: "FAILED", previewFormat: null, previewError: "转换失败" }] },
      ],
    }))));

    render(<PolicyAdmin />);
    expect(await screen.findByText("全体在职员工")).toBeTruthy();
    expect(screen.queryByText("适用城市")).toBeNull();
    expect(await screen.findByText(/Office 转换器可用/)).toBeTruthy();

    const readyArticle = screen.getByText("可发布制度").closest("article")!;
    const failedArticle = screen.getByText("失败制度").closest("article")!;
    expect(within(readyArticle).getByRole("button", { name: "发布" })).toHaveProperty("disabled", false);
    expect(within(failedArticle).getByRole("button", { name: "发布" })).toHaveProperty("disabled", true);
    expect(within(failedArticle).getByRole("button", { name: "重新生成预览" })).toBeTruthy();

    const upload = document.querySelector<HTMLInputElement>('form.policy-upload-form input[type="file"]');
    expect(upload?.accept).toContain(".docx");
    expect(upload?.accept).toContain(".xlsx");
    expect(upload?.accept).toContain(".pptx");
    expect(upload?.accept).toContain(".csv");
  });

  it("exposes distinct delete entry with version/whole confirmation and recycle bin restore", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/policies" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({
          ok: true,
          previewEnvironment: { available: true, chineseFontAvailable: true },
          policies: [{
            id: "p1",
            name: "待删制度",
            category: "通用",
            status: "PUBLISHED",
            sortOrder: 0,
            versions: [
              { id: "v2", versionNumber: "2.0", effectiveDate: new Date().toISOString(), previewStatus: "READY", previewFormat: "PDF", previewError: null },
              { id: "v1", versionNumber: "1.0", effectiveDate: new Date().toISOString(), previewStatus: "READY", previewFormat: "PDF", previewError: null },
            ],
          }],
        }));
      }
      if (url === "/api/admin/policies/recycle-bin") {
        return new Response(JSON.stringify({
          ok: true,
          policies: [{ id: "recycled", name: "回收制度", category: "通用", deletedAt: new Date().toISOString(), statusBeforeDelete: "PUBLISHED", versions: [] }],
          versions: [{
            id: "recycled-version",
            versionNumber: "1.0",
            effectiveDate: new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            previewStatus: "READY",
            previewFormat: "PDF",
            previewError: null,
            policy: { id: "active-policy", name: "仍有效制度", category: "通用", status: "PUBLISHED" },
          }],
        }));
      }
      if (url.includes("/recycle") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, publishOutcome: "ROLLED_BACK", rolledBackToVersionNumber: "1.0" }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PolicyAdmin />);
    expect(await screen.findByText("待删制度")).toBeTruthy();
    const article = screen.getByText("待删制度").closest("article")!;
    fireEvent.click(within(article).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除制度确认" });
    expect(within(dialog).getByText(/资料名称：/)).toBeTruthy();
    expect(within(dialog).getByText(/当前版本：/)).toBeTruthy();
    expect(within(dialog).getByText(/历史版本数量：/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除当前版本" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/policies/p1/versions/v2/recycle"),
      expect.objectContaining({ method: "POST" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: /回收站/ }));
    const recycleDialog = await screen.findByRole("dialog", { name: "制度回收站" });
    expect(within(recycleDialog).getByText("回收制度")).toBeTruthy();
    expect(within(recycleDialog).getByText(/仍有效制度 · v1.0/)).toBeTruthy();
    fireEvent.click(within(recycleDialog).getByRole("button", { name: "恢复版本 v1.0" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/policies/active-policy/versions/recycled-version/recycle/restore"),
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(within(recycleDialog).getByRole("button", { name: /恢复整份/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/policies/recycled/recycle/restore"),
      expect.objectContaining({ method: "POST" }),
    ));
  });
});
