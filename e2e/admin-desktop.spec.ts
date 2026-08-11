import path from "node:path";
import { expect, test } from "@playwright/test";

test("administrator creates an employee, imports a synthetic roster and opens the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill("e2e-admin");
  await page.getByLabel("密码").fill("AdminE2EPass!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "入职学习看板" })).toBeVisible();
  await expect(page.locator(".admin-sidebar")).toBeVisible();

  await page.goto("/admin/employees/new");
  await page.getByLabel("工号 *").fill("E2E-CREATED");
  await page.getByLabel("姓名 *").fill("手工虚构员工");
  await page.getByLabel("邮箱 *").fill("created-e2e@example.invalid");
  await page.getByLabel("入职日期 *").fill("2026-07-01");
  await page.getByLabel("一级部门").fill("演示中心");
  await page.getByLabel("工作地点 *").selectOption("CHANGSHA");
  await page.getByRole("button", { name: "创建员工" }).click();
  await expect(page).toHaveURL(/\/admin\/employees$/);
  await expect(page.locator(".employee-table").getByText("E2E-CREATED", { exact: true })).toBeVisible();

  await page.goto("/admin/roster/import");
  await page.getByLabel("选择员工名册").setInputFiles(
    path.resolve("artifacts/e2e-inputs/e2e-roster.xlsx"),
  );
  await page.getByRole("button", { name: "开始预检" }).click();
  await expect(page.getByText("预检完成。请确认摘要并处理全部冲突。")).toBeVisible();
  await page.locator(".issue-list select").first().selectOption("KEEP_FIRST");
  await page.getByRole("button", { name: "确认并提交导入" }).click();
  await expect(page.getByText(/导入完成：新增 1/)).toBeVisible();

  await page.goto("/admin/employees");
  await expect(page.locator(".employee-table").getByText("E2E-ROSTER", { exact: true })).toBeVisible();
  await page.locator(".employee-table").getByLabel("选择 名册虚构员工甲").check();
  await page.locator(".bulk-bar select").selectOption("SHANGHAI");
  await expect(page.getByText("已更新 1 名员工的工作地点")).toBeVisible();

  const createdRow = page.locator(".employee-table tbody tr").filter({ hasText: "E2E-CREATED" });
  await createdRow.getByRole("link", { name: "编辑" }).click();
  await expect(page.getByRole("heading", { name: "编辑员工" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重置密码" })).toBeVisible();

  await page.goto("/admin/guides");
  await expect(page.locator(".guide-editor")).toHaveCount(4);
  await expect(page.locator(".chapter-admin-list form").first()).toBeVisible();

  await page.goto("/admin/policies");
  await expect(page.locator(".policy-replace-form")).toHaveCount(1);

  await page.goto("/admin/questions");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.locator(".question-admin-list > .question-editor")).toHaveCount(23);
  await expect(page.locator(".question-total")).toContainText("100");

  await page.goto("/admin/reminders");
  await expect(page.locator(".reminder-filters")).toBeVisible();
  await expect(page.getByRole("link", { name: "导出当前筛选 CSV" })).toBeVisible();

  await page.goto("/admin");
  await expect(page.getByText("员工总数")).toBeVisible();
  await expect(page.getByRole("heading", { name: "考试任务分布" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByText("CohortHarbor", { exact: true })).toBeVisible();
  const welcome = page.getByRole("heading", { name: "端到端管理员，欢迎开启入职学习旅程" });
  await expect(welcome).toBeVisible();
  expect(await welcome.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      doesNotOverflow: element.scrollWidth <= element.clientWidth,
      whiteSpace: style.whiteSpace,
    };
  })).toEqual({ fontSize: 44, doesNotOverflow: true, whiteSpace: "nowrap" });
});
