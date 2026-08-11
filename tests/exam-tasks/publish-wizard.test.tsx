// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishExamTaskWizard } from "@/features/exam-tasks/components/publish-exam-task-wizard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publish exam task wizard UI", () => {
  it("walks four steps, auto-selects default bank, and keeps cross-page selection", async () => {
    const banks = [
      {
        id: "bank-default",
        name: "默认卷",
        description: "默认描述",
        isDefault: true,
        status: "ENABLED",
        versionNumber: 2,
        enabledScore: 100,
        questionCount: 10,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "bank-other",
        name: "备选卷",
        description: null,
        isDefault: false,
        status: "ENABLED",
        versionNumber: 1,
        enabledScore: 100,
        questionCount: 8,
        updatedAt: new Date().toISOString(),
      },
    ];

    const page1 = Array.from({ length: 2 }, (_, index) => ({
      id: `emp-${index + 1}`,
      employeeNo: `E-${index + 1}`,
      name: `员工${index + 1}`,
      firstDepartment: "研发中心",
      workLocation: "SHANGHAI",
      enabled: true,
      status: "ACTIVE",
    }));
    const page2 = [
      {
        id: "emp-3",
        employeeNo: "E-3",
        name: "员工3",
        firstDepartment: "研发中心",
        workLocation: "SHENZHEN",
        enabled: true,
        status: "ACTIVE",
      },
    ];

    let publishedBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/admin/exam-tasks/selectable-banks") {
        return new Response(
          JSON.stringify({ ok: true, banks, defaultBankId: "bank-default" }),
        );
      }
      if (url.pathname === "/api/admin/employees") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const items = page === 1 ? page1 : page2;
        return new Response(
          JSON.stringify({
            ok: true,
            items,
            page,
            pageSize: 2,
            total: 3,
            totalPages: 2,
          }),
        );
      }
      if (url.pathname === "/api/admin/exam-tasks/resolve-assignees" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          selection: {
            mode: string;
            userIds?: string[];
            excludedUserIds?: string[];
          };
        };
        const ids =
          body.selection.mode === "EXPLICIT"
            ? (body.selection.userIds ?? [])
            : ["emp-1", "emp-2", "emp-3"].filter(
                (id) => !(body.selection.excludedUserIds ?? []).includes(id),
              );
        return new Response(
          JSON.stringify({
            ok: true,
            total: ids.length,
            employees: ids.map((id) => ({
              id,
              employeeNo: id.replace("emp-", "E-"),
              name: `员工${id.replace("emp-", "")}`,
              firstDepartment: "研发中心",
              workLocation: "SHANGHAI",
            })),
          }),
        );
      }
      if (url.pathname === "/api/admin/exam-tasks" && method === "POST") {
        publishedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            ok: true,
            task: {
              id: "task-1",
              replayed: false,
              assignmentCount: 2,
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ ok: false, message: `unexpected ${url.pathname}` }), {
        status: 500,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PublishExamTaskWizard />);

    expect(await screen.findByRole("heading", { name: "发布考试任务" })).toBeTruthy();
    expect(await screen.findByText("默认卷")).toBeTruthy();
    const defaultRadio = screen.getByRole("radio", { name: /默认卷/ });
    expect(defaultRadio).toHaveProperty("checked", true);

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("heading", { name: "2. 选择员工" })).toBeTruthy();

    const firstChecks = await screen.findAllByLabelText("选择 员工1");
    fireEvent.click(firstChecks[0]!);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    const thirdChecks = await screen.findAllByLabelText("选择 员工3");
    fireEvent.click(thirdChecks[0]!);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    const firstAgain = await screen.findAllByLabelText("选择 员工1");
    expect(firstAgain[0]).toHaveProperty("checked", true);
    expect(screen.getByText(/已选择\s*2\s*人/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("heading", { name: "3. 时间与规则" })).toBeTruthy();
    expect(screen.getAllByText(/Asia\/Shanghai/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("考试名称"), {
      target: { value: "向导发布考试" },
    });
    expect(screen.getByLabelText("及格分（默认 80）")).toHaveProperty("value", "80");

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("heading", { name: "4. 确认发布" })).toBeTruthy();
    expect(screen.getByText(/默认卷/)).toBeTruthy();
    expect(screen.getByText(/2 人/)).toBeTruthy();
    const list = screen.getByLabelText("已选名单");
    expect(within(list).getByText(/员工1/)).toBeTruthy();
    expect(within(list).getByText(/员工3/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(publishedBody).toBeTruthy());
    expect(publishedBody).toMatchObject({
      name: "向导发布考试",
      questionBankId: "bank-default",
      passingScore: 80,
      selection: {
        mode: "EXPLICIT",
        userIds: expect.arrayContaining(["emp-1", "emp-3"]),
      },
    });
    expect(await screen.findByText(/发布成功/)).toBeTruthy();
  });

  it("supports select-all-filtered and shows four step labels", async () => {
    const resolvedSelections: Array<{ mode: string; filter?: { query?: string } }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.pathname === "/api/admin/exam-tasks/selectable-banks") {
        return new Response(
          JSON.stringify({
            ok: true,
            defaultBankId: "bank-1",
            banks: [
              {
                id: "bank-1",
                name: "唯一卷",
                description: null,
                isDefault: true,
                status: "ENABLED",
                versionNumber: 1,
                enabledScore: 100,
                questionCount: 1,
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/admin/employees") {
        return new Response(
          JSON.stringify({
            ok: true,
            items: [
              {
                id: "e1",
                employeeNo: "E1",
                name: "甲",
                firstDepartment: "研发中心",
                workLocation: "SHANGHAI",
                enabled: true,
                status: "ACTIVE",
              },
            ],
            page: 1,
            pageSize: 20,
            total: 5,
            totalPages: 1,
          }),
        );
      }
      if (url.pathname === "/api/admin/exam-tasks/resolve-assignees") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          selection: { mode: string; filter?: { query?: string } };
        };
        expect(body.selection.mode).toBe("FILTER");
        resolvedSelections.push(body.selection);
        return new Response(
          JSON.stringify({
            ok: true,
            total: 5,
            employees: Array.from({ length: 5 }, (_, index) => ({
              id: `e${index + 1}`,
              employeeNo: `E${index + 1}`,
              name: `员工${index + 1}`,
              firstDepartment: "研发中心",
              workLocation: "SHANGHAI",
            })),
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PublishExamTaskWizard />);
    for (const label of ["选择题库", "选择员工", "时间与规则", "确认发布"]) {
      expect(await screen.findByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    fireEvent.click(await screen.findByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "全选全部筛选结果" }));
    await waitFor(() => expect(screen.getByText(/已选择\s*5\s*人/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("姓名或工号"), { target: { value: "员工1" } });
    expect(screen.getByText(/筛选全选模式/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await waitFor(() => expect(resolvedSelections).toHaveLength(2));
    expect(resolvedSelections[1]).toMatchObject({ mode: "FILTER", filter: { query: "员工1" } });
  });
});
