// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeeAdmin } from "@/features/employees/components/employee-admin";
import { AdminResults } from "@/features/exams/components/admin-results";
import { RetakeAdmin } from "@/features/exams/components/retake-admin";
import { RosterHistory } from "@/features/roster/components/roster-history";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function responseFor(url: string) {
  if (url.includes("/employees")) return { ok: true, items: [] };
  if (url.includes("/results")) return { ok: true, assignments: [] };
  if (url.includes("/retakes")) return { ok: true, applications: [] };
  return { ok: true, batches: [] };
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(responseFor(String(input)))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("dashboard target URL filters", () => {
  it("initializes employee filters from the URL, writes changes, and follows popstate", async () => {
    window.history.replaceState({}, "", "/admin/employees?query=Alice&location=UNSET&enabled=true");
    const fetchMock = stubFetch();
    render(<EmployeeAdmin />);

    expect((screen.getByLabelText("搜索") as HTMLInputElement).value).toBe("Alice");
    expect((screen.getByLabelText("工作地点") as HTMLSelectElement).value).toBe("UNSET");
    expect((screen.getByLabelText("账号状态") as HTMLSelectElement).value).toBe("true");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes("query=Alice") && String(url).includes("location=UNSET") && String(url).includes("enabled=true"))).toBe(true));

    fireEvent.change(screen.getByLabelText("账号状态"), { target: { value: "false" } });
    expect(new URLSearchParams(window.location.search).get("enabled")).toBe("false");

    window.history.replaceState({}, "", "/admin/employees?location=SHANGHAI&enabled=true");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect((screen.getByLabelText("工作地点") as HTMLSelectElement).value).toBe("SHANGHAI"));
    expect((screen.getByLabelText("账号状态") as HTMLSelectElement).value).toBe("true");
  });

  it("initializes result status from the URL and keeps it synchronized with history", async () => {
    window.history.replaceState({}, "", "/admin/results?status=PASSED");
    stubFetch();
    render(<AdminResults />);

    expect((screen.getByLabelText("任务状态") as HTMLSelectElement).value).toBe("PASSED");
    fireEvent.change(screen.getByLabelText("任务状态"), { target: { value: "FAILED" } });
    expect(new URLSearchParams(window.location.search).get("status")).toBe("FAILED");
    window.history.replaceState({}, "", "/admin/results?status=IN_PROGRESS");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect((screen.getByLabelText("任务状态") as HTMLSelectElement).value).toBe("IN_PROGRESS"));
  });

  it("initializes retake status from the URL and keeps it synchronized with history", async () => {
    window.history.replaceState({}, "", "/admin/retakes?status=PENDING");
    stubFetch();
    render(<RetakeAdmin />);

    expect((screen.getByLabelText("审批状态") as HTMLSelectElement).value).toBe("PENDING");
    fireEvent.change(screen.getByLabelText("审批状态"), { target: { value: "APPROVED" } });
    expect(new URLSearchParams(window.location.search).get("status")).toBe("APPROVED");
    window.history.replaceState({}, "", "/admin/retakes?status=REJECTED");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect((screen.getByLabelText("审批状态") as HTMLSelectElement).value).toBe("REJECTED"));
  });

  it("initializes roster status from the URL and keeps it synchronized with history", async () => {
    window.history.replaceState({}, "", "/admin/roster/history?status=COMMITTED");
    stubFetch();
    render(<RosterHistory />);

    expect((screen.getByLabelText("批次状态") as HTMLSelectElement).value).toBe("COMMITTED");
    fireEvent.change(screen.getByLabelText("批次状态"), { target: { value: "FAILED" } });
    expect(new URLSearchParams(window.location.search).get("status")).toBe("FAILED");
    window.history.replaceState({}, "", "/admin/roster/history?status=READY");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect((screen.getByLabelText("批次状态") as HTMLSelectElement).value).toBe("READY"));
  });
});
