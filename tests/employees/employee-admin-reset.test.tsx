// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeeAdmin } from "@/features/employees/components/employee-admin";
import { EmployeeEditForm } from "@/features/employees/components/employee-edit-form";

const employee = {
  id: "employee-1",
  employeeNo: "E-001",
  name: "示例员工",
  email: "zhangsan@example.invalid",
  firstDepartment: "研发中心",
  secondDepartment: null,
  position: "工程师",
  workLocation: "SHANGHAI",
  status: "ACTIVE",
  enabled: true,
  sourceType: "MANUAL",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("employee password reset UI", () => {
  function deferredResponse() {
    let resolve!: (response: Response) => void;
    return {
      promise: new Promise<Response>((next) => { resolve = next; }),
      resolve,
    };
  }

  it("shows the generated password once and clears it when dismissed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, temporaryPassword: "Ab3Cd5Ef7G" }));
      }
      return new Response(JSON.stringify({ ok: true, items: [employee] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeAdmin />);

    await screen.findAllByText("示例员工");
    fireEvent.click(screen.getAllByRole("button", { name: "重置密码" })[0]!);

    expect(await screen.findByText("Ab3Cd5Ef7G")).toBeTruthy();
    expect(screen.getByText("一次性临时密码")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我已记录，关闭" }));
    await waitFor(() => expect(screen.queryByText("Ab3Cd5Ef7G")).toBeNull());
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reset-password"))).toHaveLength(1);
  });

  it("does not present the legacy fixed password from the employee edit form", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, temporaryPassword: "H7jK9mN2pQ" }));
      }
      return new Response(JSON.stringify({
        ok: true,
        employee: {
          ...employee,
          hiredAt: "2026-07-01T00:00:00.000Z",
          leftAt: null,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<EmployeeEditForm employeeId="employee-1" />);

    await screen.findByDisplayValue("示例员工");
    expect(screen.queryByText(/DemoEmployeePass2026/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByText("H7jK9mN2pQ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我已记录，关闭" }));
    await waitFor(() => expect(screen.queryByText("H7jK9mN2pQ")).toBeNull());
  });

  it("blocks overlapping employee-list resets and cannot display a stale second password", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") {
        return pending.promise;
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, items: [employee] })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeAdmin />);

    await screen.findAllByText("示例员工");
    const buttons = screen.getAllByRole("button", { name: "重置密码" });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true));
    fireEvent.click(buttons[1]!);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reset-password"))).toHaveLength(1);

    pending.resolve(new Response(JSON.stringify({ ok: true, temporaryPassword: "NewestPass1" })));
    expect(await screen.findByText("NewestPass1")).toBeTruthy();
    expect(screen.queryByText("StalePass2")).toBeNull();
  });

  it("blocks overlapping edit-form resets while one request is pending", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") return pending.promise;
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        employee: { ...employee, hiredAt: "2026-07-01T00:00:00.000Z", leftAt: null },
      })));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<EmployeeEditForm employeeId="employee-1" />);

    await screen.findByDisplayValue("示例员工");
    const button = screen.getByRole("button", { name: "重置密码" });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reset-password"))).toHaveLength(1);
    pending.resolve(new Response(JSON.stringify({ ok: true, temporaryPassword: "EditNewest1" })));
    expect(await screen.findByText("EditNewest1")).toBeTruthy();
  });

  it("erases edit-form reset secrets and ignores late responses across employee navigation", async () => {
    const lateEmployeeAReset = deferredResponse();
    let employeeAResetCount = 0;
    const employeeA = {
      ...employee,
      id: "employee-a",
      employeeNo: "E-A",
      name: "员工甲",
      hiredAt: "2026-07-01T00:00:00.000Z",
      leftAt: null,
    };
    const employeeB = {
      ...employeeA,
      id: "employee-b",
      employeeNo: "E-B",
      name: "员工乙",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/employee-a/reset-password") && init?.method === "POST") {
        employeeAResetCount += 1;
        if (employeeAResetCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            temporaryPassword: "ShownForA1",
          })));
        }
        return lateEmployeeAReset.promise;
      }
      const requestedEmployee = url.endsWith("/employee-b") ? employeeB : employeeA;
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        employee: requestedEmployee,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = render(<EmployeeEditForm employeeId="employee-a" />);

    await screen.findByDisplayValue("员工甲");
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByText("ShownForA1")).toBeTruthy();

    view.rerender(<EmployeeEditForm employeeId="employee-b" />);
    await screen.findByDisplayValue("员工乙");
    expect(screen.queryByText("ShownForA1")).toBeNull();
    view.rerender(<EmployeeEditForm employeeId="employee-a" />);
    await screen.findByDisplayValue("员工甲");
    expect(screen.queryByText("ShownForA1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    view.rerender(<EmployeeEditForm employeeId="employee-b" />);
    await screen.findByDisplayValue("员工乙");
    lateEmployeeAReset.resolve(new Response(JSON.stringify({
      ok: true,
      temporaryPassword: "LateForA2",
    })));
    await waitFor(() => expect(screen.queryByText("LateForA2")).toBeNull());
    view.rerender(<EmployeeEditForm employeeId="employee-a" />);
    await screen.findByDisplayValue("员工甲");
    expect(screen.queryByText("LateForA2")).toBeNull();
  });

  it("shows a visible error for malformed employee-list reset responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") {
        return new Response("not-json");
      }
      return new Response(JSON.stringify({ ok: true, items: [employee] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeAdmin />);
    await screen.findAllByText("示例员工");
    fireEvent.click(screen.getAllByRole("button", { name: "重置密码" })[0]!);
    expect(await screen.findByText("密码重置失败")).toBeTruthy();
  });

  it("shows a visible error for edit-form reset network failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reset-password") && init?.method === "POST") {
        throw new Error("network unavailable");
      }
      return new Response(JSON.stringify({
        ok: true,
        employee: { ...employee, hiredAt: "2026-07-01T00:00:00.000Z", leftAt: null },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<EmployeeEditForm employeeId="employee-1" />);
    await screen.findByDisplayValue("示例员工");
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(await screen.findByText("密码重置失败")).toBeTruthy();
  });
});
