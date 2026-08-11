// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { ModuleSettings } from "@/features/employee-modules/components/module-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModuleSettings", () => {
  it("renders all seven fixed switches and saves the complete enabled set", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      enabledKeys: [EmployeeModuleKey.GUIDES, EmployeeModuleKey.POLICIES],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ModuleSettings initialEnabledKeys={Object.values(EmployeeModuleKey)} />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    fireEvent.click(screen.getByRole("checkbox", { name: /学习考试/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存板块设置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/employee-modules",
      expect.objectContaining({
        method: "PATCH",
        body: expect.not.stringContaining(`\"${EmployeeModuleKey.EXAM}\"`),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("板块设置已保存");
  });

  it("keeps the unsaved selection visible and reports transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    render(<ModuleSettings initialEnabledKeys={[EmployeeModuleKey.GUIDES]} />);
    const policies = screen.getByRole("checkbox", { name: /制度学习/ }) as HTMLInputElement;
    fireEvent.click(policies);
    fireEvent.click(screen.getByRole("button", { name: "保存板块设置" }));
    expect((await screen.findByRole("alert")).textContent).toContain("保存失败，请稍后重试");
    expect(policies.checked).toBe(true);
  });
});
