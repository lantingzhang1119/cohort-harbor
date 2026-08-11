import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmployeeModuleKey, Role } from "@/generated/prisma/enums";
import { EmployeeModuleQuickLinks, EmployeeModuleVisibilityProvider } from "@/features/employee-modules/components/module-visibility";
import { AppShell } from "@/lib/ui/app-shell";

describe("employee module navigation model", () => {
  it("filters desktop and mobile navigation while preserving account controls", () => {
    const html = renderToStaticMarkup(
      <AppShell
        variant="employee"
        user={{ name: "导航管理员", employeeNo: "NAV-ADMIN", role: Role.ADMIN }}
        enabledEmployeeModules={[EmployeeModuleKey.GUIDES, EmployeeModuleKey.RESULTS]}
      >
        <div>页面内容</div>
      </AppShell>,
    );

    expect(html).toContain("首页");
    expect(html).toContain("四城指南");
    expect(html).toContain("考试结果");
    expect(html).not.toContain("入职资料包");
    expect(html).not.toContain("制度学习");
    expect(html).not.toContain("学习考试");
    expect(html).not.toContain("补考申请");
    expect(html).not.toContain(">通知<");
    expect(html).toContain('/employee/profile');
    expect(html).toContain("切换到管理端");
    expect(html).toContain("退出登录");
  });

  it("uses the same enabled set for employee-home quick links", () => {
    const html = renderToStaticMarkup(
      <EmployeeModuleVisibilityProvider enabledKeys={[EmployeeModuleKey.ONBOARDING_KIT]}>
        <EmployeeModuleQuickLinks />
      </EmployeeModuleVisibilityProvider>,
    );
    expect(html).toContain("入职资料包");
    expect(html).not.toContain("四城指南");
    expect(html).not.toContain("制度学习");
  });
});
