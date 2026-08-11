import { expect, test } from "@playwright/test";

test("same-account view switching preserves server-side admin and employee boundaries", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("姓名 / 工号").fill("e2e-admin");
  await page.getByLabel("密码").fill("AdminE2EPass!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("button", { name: "切换到员工端" })).toHaveCount(1);
  expect(await page.evaluate(async () => (await fetch("/api/admin/employees")).status)).toBe(200);
  expect(await page.evaluate(async () => (await fetch("/api/guides")).status)).toBe(403);

  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await expect(page.getByRole("button", { name: "切换到管理端" })).toHaveCount(1);
  expect(await page.evaluate(async () => (await fetch("/api/admin/employees")).status)).toBe(403);
  expect(await page.evaluate(async () => (await fetch("/api/guides")).status)).toBe(200);
  await page.goto("/employee/exam");
  await expect(page.getByText("当前管理账号暂无学习任务")).toBeVisible();
  expect(await page.evaluate(async () => (await fetch("/api/exam/start", { method: "POST" })).status)).toBe(404);

  await page.getByRole("button", { name: "切换到管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("姓名 / 工号").fill("E2E-SEC");
  await page.getByLabel("密码").fill("EmployeeSecure!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/employee$/);

  await page.goto("/admin/employees");
  await expect(page).toHaveURL(/\/employee$/);
  const status = await page.evaluate(async () => (await fetch("/api/admin/employees")).status);
  expect(status).toBe(403);
  await expect(page.getByRole("button", { name: /切换到/ })).toHaveCount(0);
  const switchStatus = await page.evaluate(async () =>
    (await fetch("/api/auth/view-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetMode: "ADMIN" }),
    })).status,
  );
  expect(switchStatus).toBe(403);

  const privateResponse = await page.request.get("/storage/private/e2e.db");
  expect(privateResponse.status()).toBe(404);
});

test("employee module settings immediately govern navigation, direct pages and APIs", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill("e2e-admin");
  await page.getByLabel("密码").fill("AdminE2EPass!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto("/admin/settings");
  const policySwitch = page.getByRole("checkbox", { name: /制度学习/ });
  await expect(policySwitch).toBeChecked();
  let primaryError: unknown;
  try {
    await policySwitch.uncheck();
    await page.getByRole("button", { name: "保存板块设置" }).click();
    await expect(page.getByText("板块设置已保存", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "切换到员工端" }).click();
    await expect(page).toHaveURL(/\/employee$/);
    await expect(page.getByRole("link", { name: "制度学习" })).toHaveCount(0);
    expect(await page.evaluate(async () => (await fetch("/api/policies")).status)).toBe(403);
    await page.goto("/employee/policies");
    await expect(page).toHaveURL(/\/employee\?notice=module-closed$/);
    await expect(page.getByRole("status")).toHaveText("该板块当前未开放");
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    const switchResponse = await page.request.post("/api/auth/view-mode", {
      data: { targetMode: "ADMIN" },
      headers: { origin: "http://127.0.0.1:3100" },
    });
    expect(switchResponse.ok()).toBe(true);
    await page.goto("/admin/settings");
    const restorePolicySwitch = page.getByRole("checkbox", { name: /制度学习/ });
    if (!(await restorePolicySwitch.isChecked())) {
      await restorePolicySwitch.check();
      await page.getByRole("button", { name: "保存板块设置" }).click();
      await expect(page.getByText("板块设置已保存", { exact: true })).toBeVisible();
    }
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "员工端板块安全回归和状态恢复均失败");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
});
