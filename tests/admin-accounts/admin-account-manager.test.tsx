// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Role, UserStatus } from "@/generated/prisma/enums";
import {
  adminAccountStatusLabel,
  AdminAccountManager,
  isOperationallyActiveAdmin,
  partitionOrdinaryAdminAccounts,
  postTransferDestination,
} from "@/features/admin-accounts/components/admin-account-manager";
import { AdminSidebar } from "@/lib/ui/admin-sidebar";

const ordinaryAdministrator = {
  id: "admin-1",
  employeeNo: "ADMIN-001",
  name: "普通管理员",
  email: "admin@example.invalid",
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  enabled: true,
  mustChangePassword: true,
  adminArchivedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("administrator account management UI", () => {
  it("exposes the complete lifecycle controls and protected confirmation copy", () => {
    const html = renderToStaticMarkup(<AdminAccountManager />);
    expect(html).toContain("创建管理员");
    expect(html).toContain("账号接管");
    expect(html).toContain("归档账号");
    expect(html).toContain("恢复账号");
    expect(html).toContain("永久删除管理员");
    expect(html).toContain("一次性临时密码");
    expect(html).toContain('pattern="(?=.*[A-Za-z])(?=.*\\d).{8,}"');
  });

  it("shows the administrator-account navigation only to super administrators", () => {
    const superHtml = renderToStaticMarkup(<AdminSidebar role={Role.SUPER_ADMIN} />);
    const adminHtml = renderToStaticMarkup(<AdminSidebar role={Role.ADMIN} />);
    expect(superHtml).toContain("管理员账号");
    expect(adminHtml).not.toContain("管理员账号");
  });

  it("requires a fresh login after the super administrator transfers itself", () => {
    expect(postTransferDestination(Role.SUPER_ADMIN)).toBe("/login");
    expect(postTransferDestination(Role.ADMIN)).toBeNull();
  });

  it("classifies a legacy disabled ordinary administrator as disabled rather than active", () => {
    const legacy = {
      role: Role.ADMIN,
      status: "DISABLED" as const,
      enabled: false,
      adminArchivedAt: null,
    };
    expect(isOperationallyActiveAdmin(legacy)).toBe(false);
    expect(adminAccountStatusLabel(legacy)).toBe("已停用");
    expect(partitionOrdinaryAdminAccounts([legacy])).toEqual({
      active: [],
      disabled: [legacy],
    });
  });

  it("shows an actionable error when administrator creation cannot reach the server", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("network unavailable");
      return new Response(JSON.stringify({ ok: true, items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAccountManager />);

    await screen.findByText("暂无管理员账号");
    fireEvent.click(screen.getByRole("button", { name: "创建管理员" }));
    const createDialog = within(screen.getByRole("dialog"));
    fireEvent.change(createDialog.getByLabelText("工号"), { target: { value: "ADMIN-002" } });
    fireEvent.change(createDialog.getByLabelText("姓名"), { target: { value: "新管理员" } });
    fireEvent.change(createDialog.getByLabelText("邮箱"), { target: { value: "new-admin@example.invalid" } });
    fireEvent.click(createDialog.getByRole("button", { name: "确认创建" }));

    expect((await screen.findByText("创建失败，请检查网络连接后重试")).textContent).toBe("创建失败，请检查网络连接后重试");
    expect(createDialog.getByRole("button", { name: "确认创建" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a visible retry message when a lifecycle mutation returns malformed JSON", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("upstream proxy error", { status: 502 });
      return new Response(JSON.stringify({ ok: true, items: [ordinaryAdministrator] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAccountManager />);

    await screen.findByText("普通管理员");
    fireEvent.click(screen.getByRole("button", { name: "归档账号" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    expect((await screen.findByText("操作失败，请稍后重试")).textContent).toBe("操作失败，请稍后重试");
    expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a created credential once and removes it after explicit dismissal", async () => {
    const createdAdministrator = {
      ...ordinaryAdministrator,
      id: "admin-2",
      employeeNo: "ADMIN-002",
      name: "新管理员",
      email: "new-admin@example.invalid",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          ok: true,
          admin: createdAdministrator,
          temporaryPassword: "Ab3Cd5Ef7G",
        }));
      }
      return new Response(JSON.stringify({ ok: true, items: [createdAdministrator] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAccountManager />);

    await screen.findByText("新管理员");
    fireEvent.click(screen.getByRole("button", { name: "创建管理员" }));
    const createDialog = within(screen.getByRole("dialog"));
    fireEvent.change(createDialog.getByLabelText("工号"), { target: { value: "ADMIN-002" } });
    fireEvent.change(createDialog.getByLabelText("姓名"), { target: { value: "新管理员" } });
    fireEvent.change(createDialog.getByLabelText("邮箱"), { target: { value: "new-admin@example.invalid" } });
    fireEvent.click(createDialog.getByRole("button", { name: "确认创建" }));

    expect(await screen.findByText("Ab3Cd5Ef7G")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我已保存，关闭" }));
    await waitFor(() => expect(screen.queryByText("Ab3Cd5Ef7G")).toBeNull());
  });
});
