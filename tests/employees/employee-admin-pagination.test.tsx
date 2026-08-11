// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmployeeAdmin } from "@/features/employees/components/employee-admin";

type MockEmployee = {
  id: string;
  employeeNo: string;
  name: string;
  email: string | null;
  firstDepartment: string | null;
  secondDepartment: string | null;
  position: string | null;
  workLocation: string;
  status: string;
  enabled: boolean;
  sourceType: string;
};

function makeEmployee(index: number): MockEmployee {
  const sequence = String(index + 1).padStart(3, "0");
  return {
    id: `employee-${sequence}`,
    employeeNo: `E-${sequence}`,
    name: `员工${sequence}`,
    email: `emp${sequence}@example.invalid`,
    firstDepartment: "研发中心",
    secondDepartment: null,
    position: "工程师",
    workLocation: "SHANGHAI",
    status: "ACTIVE",
    enabled: true,
    sourceType: index % 2 === 0 ? "MANUAL" : "EXCEL",
  };
}

const allEmployees = Array.from({ length: 105 }, (_, index) => makeEmployee(index));

function paginate(items: MockEmployee[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    ok: true as const,
    items: items.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/admin/employees");
});

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/employees");
});

describe("employee admin pagination UI", () => {
  function mockListApi(handler?: (url: URL) => Response | Promise<Response>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.pathname === "/api/admin/employees" && (!init?.method || init.method === "GET")) {
        if (handler) return handler(url);
        const page = Number(url.searchParams.get("page") ?? "1");
        const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
        return new Response(JSON.stringify(paginate(allEmployees, page, pageSize)));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("requests page and pageSize and renders first/previous/next/last controls with totals", async () => {
    const fetchMock = mockListApi();
    render(<EmployeeAdmin />);

    await screen.findAllByText("员工001");
    expect(await screen.findByText(/共 105 名员工/)).toBeTruthy();
    expect(screen.getByText(/第 1 \/ 6 页/)).toBeTruthy();

    const listCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/admin/employees"));
    expect(listCall).toBeTruthy();
    const requested = new URL(String(listCall![0]), "http://localhost:3000");
    expect(requested.searchParams.get("page")).toBe("1");
    expect(requested.searchParams.get("pageSize")).toBe("20");

    const pagination = screen.getByRole("navigation", { name: "员工分页" });
    expect(within(pagination).getByRole("button", { name: "首页" })).toHaveProperty("disabled", true);
    expect(within(pagination).getByRole("button", { name: "上一页" })).toHaveProperty("disabled", true);
    expect(within(pagination).getByRole("button", { name: "下一页" })).toHaveProperty("disabled", false);
    expect(within(pagination).getByRole("button", { name: "末页" })).toHaveProperty("disabled", false);

    fireEvent.click(within(pagination).getByRole("button", { name: "末页" }));
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1);
      const url = new URL(String(lastCall?.[0]), "http://localhost:3000");
      expect(url.searchParams.get("page")).toBe("6");
    });
    await screen.findByText(/第 6 \/ 6 页/);
    expect(screen.getAllByText("员工105").length).toBeGreaterThan(0);
  });

  it("resets to page 1 when filters change and corrects page when page size changes", async () => {
    const fetchMock = mockListApi();
    render(<EmployeeAdmin initialFilters={{ page: "3", pageSize: "20" }} />);

    await screen.findByText(/第 3 \/ 6 页/);

    fireEvent.change(screen.getByPlaceholderText("姓名或工号"), { target: { value: "员工001" } });
    await waitFor(() => {
      const latest = fetchMock.mock.calls.at(-1);
      const url = new URL(String(latest?.[0]), "http://localhost:3000");
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.get("query")).toBe("员工001");
    });

    fireEvent.change(screen.getByLabelText("每页显示"), { target: { value: "50" } });
    await waitFor(() => {
      const latest = fetchMock.mock.calls.at(-1);
      const url = new URL(String(latest?.[0]), "http://localhost:3000");
      expect(url.searchParams.get("pageSize")).toBe("50");
      expect(url.searchParams.get("page")).toBe("1");
    });

    fireEvent.change(screen.getByLabelText("账号来源"), { target: { value: "EXCEL" } });
    await waitFor(() => {
      const latest = fetchMock.mock.calls.at(-1);
      const url = new URL(String(latest?.[0]), "http://localhost:3000");
      expect(url.searchParams.get("source")).toBe("EXCEL");
      expect(url.searchParams.get("page")).toBe("1");
    });
  });

  it("shows empty and error states clearly", async () => {
    mockListApi(async () => new Response(JSON.stringify({ ok: true, items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 })));
    const { unmount } = render(<EmployeeAdmin />);
    expect(await screen.findByText("暂无符合条件的员工")).toBeTruthy();
    unmount();

    mockListApi(async () => new Response(JSON.stringify({ ok: false, message: "权限不足" })));
    render(<EmployeeAdmin />);
    expect(await screen.findByText("权限不足")).toBeTruthy();
  });

  it("auto-corrects to a valid page when the current page becomes empty", async () => {
    mockListApi(async (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      if (page > 2) {
        return new Response(
          JSON.stringify({
            ok: true,
            items: [],
            page,
            pageSize,
            total: 25,
            totalPages: 2,
          }),
        );
      }
      return new Response(JSON.stringify(paginate(allEmployees.slice(0, 25), page, pageSize)));
    });

    render(<EmployeeAdmin initialFilters={{ page: "9", pageSize: "20" }} />);

    await waitFor(() => {
      expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();
    }, { timeout: 3000 });
    expect(screen.getByText(/共 25 名员工/)).toBeTruthy();
  });
});
