// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import { BRAND } from "@/lib/brand";
import { AppShell } from "@/lib/ui/app-shell";

afterEach(cleanup);

describe("brand and employee welcome contract", () => {
  it("uses the public CohortHarbor identity everywhere users enter the app", () => {
    expect(BRAND).toEqual({
      name: "CohortHarbor",
      englishName: "CohortHarbor",
      platformName: "新人入职学习平台",
    });

    const packageManifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      name: string;
      packageManager: string;
    };
    expect(packageManifest).toMatchObject({
      name: "cohort-harbor",
      packageManager: "pnpm@11.16.0",
    });

    render(
      <AppShell
        variant="employee"
        user={{ name: "示例员工", employeeNo: "ADMIN-001", role: Role.ADMIN }}
      >
        <div>员工页面</div>
      </AppShell>,
    );

    expect(screen.getByText("CohortHarbor")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /示例员工/ })).toHaveLength(2);

    for (const sourceFile of ["src/app/page.tsx", "src/app/(auth)/login/page.tsx"]) {
      const source = readFileSync(path.resolve(sourceFile), "utf8");
      expect(source, sourceFile).toContain('/brand/cohort-harbor-mark.svg');
    }
  });

  it("renders the welcome from the authenticated session user and keeps the desktop title bounded", () => {
    const pageSource = readFileSync(
      path.resolve("src/app/(employee)/employee/page.tsx"),
      "utf8",
    );
    const css = readFileSync(path.resolve("src/app/globals.css"), "utf8");

    expect(pageSource).toContain("{user.name}，欢迎开启入职学习旅程");
    expect(pageSource).not.toContain("{dashboard.profile.name}，欢迎开启入职学习旅程");
    expect(css).toMatch(/\.employee-welcome h1\s*\{[^}]*font-size:\s*clamp\(36px,\s*3\.5vw,\s*44px\)/s);
    expect(css).toMatch(/\.employee-welcome h1\s*\{[^}]*white-space:\s*nowrap/s);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.employee-welcome h1\s*\{[^}]*white-space:\s*normal/s);
  });
});
