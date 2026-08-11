import { expect, test } from "@playwright/test";

test("admin publishes versioned onboarding material and employee downloads it as a ZIP", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill("e2e-admin");
  await page.getByLabel("密码").fill("AdminE2EPass!23");
  await page.getByRole("button", { name: "登录平台" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/onboarding-kit");
  await expect(page.getByRole("heading", { name: "入职资料包" })).toBeVisible();

  await page.getByLabel("资料名称").fill("E2E 新员工手册");
  await page.getByLabel("分类").fill("入职必读");
  await page.getByLabel("说明").fill("端到端验证资料");
  await page.getByLabel("选择资料文件").setInputFiles({ name: "welcome.txt", mimeType: "text/plain", buffer: Buffer.from("version-one") });
  await page.getByRole("button", { name: "上传为草稿" }).click();
  await expect(page.getByRole("status")).toContainText("资料草稿已创建");
  await expect(page.getByRole("heading", { name: "E2E 新员工手册" })).toBeVisible();

  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("资料已发布到员工端");
  await page.getByText("替换文件（新增版本）").click();
  await page.getByLabel("新版本文件").setInputFiles({ name: "welcome-v2.txt", mimeType: "text/plain", buffer: Buffer.from("version-two") });
  await page.getByRole("button", { name: "上传新版本" }).click();
  await expect(page.getByRole("status")).toContainText("新文件版本已保存");
  await page.getByText("版本历史", { exact: true }).click();
  await expect(page.getByRole("link", { name: "下载 v1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载 v2" })).toBeVisible();

  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/employee/onboarding-kit");
  await expect(page.getByRole("heading", { name: "E2E 新员工手册" })).toBeVisible();
  await expect(page.getByText(/v2 · welcome-v2.txt/)).toBeVisible();
  await page.getByRole("button", { name: "选择E2E 新员工手册" }).click();
  const zipDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载已选 1 项" }).click();
  const download = await zipDownload;
  expect(download.suggestedFilename()).toMatch(/^CohortHarbor入职资料包_\d{8}\.zip$/);
  expect((await download.createReadStream())?.readable).toBe(true);

  await page.getByRole("button", { name: "切换到管理端" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/onboarding-kit");
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("资料已归档");
  await page.getByRole("button", { name: "切换到员工端" }).click();
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/employee/onboarding-kit");
  await expect(page.getByRole("heading", { name: "E2E 新员工手册" })).toHaveCount(0);
});
