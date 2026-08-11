import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import { ExamLanding } from "@/features/exams/components/exam-landing";
import { AppShell } from "@/lib/ui/app-shell";

describe("responsive application shell contract", () => {
  it("renders an employee top bar and mobile bottom navigation", () => {
    const html = renderToStaticMarkup(
      <AppShell variant="employee" user={{ name: "测试员工", employeeNo: "E-001" }}>
        <div>内容</div>
      </AppShell>,
    );
    expect(html).toContain('class="employee-top-nav');
    expect(html).toContain('class="mobile-bottom-nav');
    expect(html).toContain("四城指南");
    expect(html).toContain("学习考试");
    expect(html).not.toContain("切换到管理端");
  });

  it("renders exactly one view switch for an administrator in either shell", () => {
    const employeeHtml = renderToStaticMarkup(
      <AppShell
        variant="employee"
        user={{ name: "测试管理员", employeeNo: "A-001", role: Role.ADMIN }}
      >
        <div>内容</div>
      </AppShell>,
    );
    const adminHtml = renderToStaticMarkup(
      <AppShell
        variant="admin"
        user={{ name: "测试超级管理员", employeeNo: "SA-001", role: Role.SUPER_ADMIN }}
      >
        <div>内容</div>
      </AppShell>,
    );

    expect(employeeHtml.match(/切换到管理端/g)).toHaveLength(1);
    expect(adminHtml.match(/切换到员工端/g)).toHaveLength(1);
    const employeeMobileNav = employeeHtml.match(/<nav class="mobile-bottom-nav employee"[\s\S]*?<\/nav>/)?.[0];
    expect(employeeMobileNav).toContain('href="/employee/profile"');
    expect(employeeMobileNav).toContain('aria-label="个人资料：测试管理员"');
    expect(employeeMobileNav).toContain("测试管理员");
    expect(employeeMobileNav).not.toContain("CohortHarbor");
    expect(employeeMobileNav!.indexOf('href="/employee"')).toBeLessThan(
      employeeMobileNav!.indexOf('href="/employee/profile"'),
    );
    expect(employeeMobileNav!.indexOf('href="/employee/profile"')).toBeLessThan(
      employeeMobileNav!.indexOf('href="/employee/guides"'),
    );
  });

  it("shows a management-account empty state without an exam start control", () => {
    const html = renderToStaticMarkup(
      <ExamLanding isManagementAccount hasAssignment={false} />,
    );

    expect(html).toContain("当前管理账号暂无学习任务");
    expect(html).not.toContain("开始 / 继续考试");
  });

  it("renders the administrator desktop sidebar and safe responsive CSS tokens", () => {
    const html = renderToStaticMarkup(
      <AppShell variant="admin" user={{ name: "测试管理员", employeeNo: "ADMIN" }}>
        <div>内容</div>
      </AppShell>,
    );
    expect(html).toContain('class="admin-sidebar');
    expect(html).toContain("员工与花名册");
    expect(html).toContain("审计日志");

    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/--touch-target:\s*44px/);
    expect(css).toMatch(/\.app-shell-content\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)/);
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(css).toMatch(/\.mobile-bottom-nav a span\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toMatch(/\.policy-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    expect(css).toMatch(/\.policy-replace-form\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    expect(css).toMatch(/\.pdf-controls span\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center/s);
    expect(css).toMatch(/\.question-option-editors > div\s*\{[^}]*minmax\(6rem,\s*auto\)/s);
    expect(css).not.toMatch(/\.employee-table\s*\{[^}]*width:\s*\d{4,}px/s);
  });
});
