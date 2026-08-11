// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/dashboard/dashboard-service", () => ({
  getAdminDashboard: vi.fn(async () => ({
    employees: { total: 12, enabled: 10, disabled: 2, unsetLocation: 3 },
    passRate: 75,
    pendingRetakes: 2,
    examStatuses: { PASSED: 9, IN_PROGRESS: 3 },
    recentImports: [{
      id: "batch-1",
      originalFileName: "fictional-roster.xlsx",
      sourceName: "excel-local",
      status: "COMMITTED",
      totalRows: 12,
      createdCount: 10,
      updatedCount: 2,
      conflictCount: 0,
      errorCount: 0,
    }],
  })),
}));

import AdminDashboardPage from "@/app/(admin)/admin/page";

afterEach(cleanup);

describe("administrator dashboard navigation", () => {
  it("renders every metric as one semantic link with the exact destination", async () => {
    render(await AdminDashboardPage());

    const destinations = [
      [/员工总数/, "/admin/employees"],
      [/账号启用/, "/admin/employees?enabled=true"],
      [/考试通过率/, "/admin/results"],
      [/待审批补考/, "/admin/retakes?status=PENDING"],
      [/地点未设置/, "/admin/employees?location=UNSET"],
    ] as const;

    for (const [name, href] of destinations) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.querySelector("a,button,input,select,textarea")).toBeNull();
    }
  });

  it("links exam status rows and recent import records without nested controls", async () => {
    render(await AdminDashboardPage());

    const passed = screen.getByRole("link", { name: /已通过.*9/ });
    expect(passed.getAttribute("href")).toBe("/admin/results?status=PASSED");
    const imported = screen.getByRole("link", { name: /fictional-roster\.xlsx/ });
    expect(imported.getAttribute("href")).toBe("/admin/roster/history");
    expect(imported.querySelector("a,button,input,select,textarea")).toBeNull();
  });
});
