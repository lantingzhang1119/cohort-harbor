import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

test("employee changes the initial password and completes the main mobile learning path", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill("E2E-EMP");
  await page.getByLabel("密码").fill("DemoEmployeePass2026");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByLabel("当前密码").fill("DemoEmployeePass2026");
  await page.getByLabel("新密码", { exact: true }).fill("EmployeeChanged!45");
  await page.getByLabel("确认新密码").fill("EmployeeChanged!45");
  await page.getByRole("button", { name: "保存并进入平台" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByText("CohortHarbor", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "端到端员工，欢迎开启入职学习旅程" })).toBeVisible();
  await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
  const profileEntry = page.locator(".mobile-bottom-nav").getByRole("link", { name: "个人资料：端到端员工" });
  await expect(profileEntry).toBeVisible();
  await expect(profileEntry).toContainText("端到端员工");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto("/employee/guides");
  await expect(page.getByRole("heading", { name: "四地入职指南" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "上海入职指南" })).toBeVisible();
  await page.getByRole("heading", { name: "上海入职指南" }).click();
  // The shared E2E database may be before or after portal-editor.spec publishes V1.
  // Both are valid terminal states; a load error or an endless loading state matches neither.
  await expect(
    page.getByText("上海入职指南的门户内容尚未发布。")
      .or(page.getByLabel(/四城门户发布版本/)),
  ).toBeVisible();
  await expect(page.locator(".guide-pages")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto("/employee/policies");
  await expect(page.getByText("虚构员工学习制度")).toBeVisible();
  await page.goto("/employee/exam");
  await page.getByRole("button", { name: "开始 / 继续考试" }).click();
  await expect(page).toHaveURL(/\/employee\/exam\/attempt\//);
  await expect(page.locator(".exam-questions article")).toHaveCount(23);
  await page.locator(".exam-questions article").first().locator("label").first().click();
  await expect(page.getByText("已自动保存")).toBeVisible();
  await page.getByRole("button", { name: "提交试卷" }).click();
  await expect(page).toHaveURL(/\/employee\/results$/);
  await expect(page.getByText("未通过", { exact: true })).toBeVisible();
});

test("employees in all four cities open the same private policy at 390px", async ({ page }) => {
  const employees = [
    { employeeNo: "E2E-POLICY-SH", city: "上海" },
    { employeeNo: "E2E-POLICY-SZ", city: "深圳" },
    { employeeNo: "E2E-POLICY-CS", city: "长沙" },
    { employeeNo: "E2E-POLICY-XA", city: "西安" },
  ];
  const evidenceRoot = path.resolve("artifacts/browser-evidence");
  await mkdir(evidenceRoot, { recursive: true });

  for (const [index, employee] of employees.entries()) {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("姓名 / 工号").fill(employee.employeeNo);
    await page.getByLabel("密码").fill("EmployeeSecure!23");
    await page.getByRole("button", { name: "登录平台" }).click();
    await expect(page).toHaveURL(/\/employee$/);
    await page.goto("/employee/policies");
    const policyLink = page.getByRole("link").filter({ hasText: "虚构员工学习制度" });
    await expect(policyLink).toBeVisible();
    await policyLink.click();
    await expect(page).toHaveURL(/\/employee\/policies\//);
    await expect(page.getByRole("link", { name: "← 返回制度列表" })).toBeVisible();
    await expect(page.locator(".policy-reader canvas")).toBeVisible();
    await expect(page.locator(".status-message")).toHaveCount(0, { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    if (index === 0) {
      await page.screenshot({
        path: path.join(evidenceRoot, "employee-policy-viewer-mobile-390.png"),
        fullPage: true,
      });
    }
  }
});
