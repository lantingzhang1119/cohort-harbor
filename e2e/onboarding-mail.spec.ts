import { expect, test, type Page } from "@playwright/test";

import { OnboardingMailDeliverySource, OnboardingMailDeliveryStatus } from "../src/generated/prisma/enums";
import { createPrismaClient } from "../src/lib/db/create-client";

const tabs = ["邮件模板", "常用字段", "今日待发送", "发送记录"];

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("姓名 / 工号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录平台" }).click();
}

async function expectMailCenter(page: Page) {
  await page.goto("/admin/onboarding-mail");
  await expect(page.getByRole("heading", { name: "新人欢迎邮件中心" })).toBeVisible();
  for (const tab of tabs) await expect(page.getByRole("tab", { name: tab })).toBeVisible();
}

test("SUPER_ADMIN and ADMIN complete the welcome-mail workflow while employees are denied", async ({ page }) => {
  await login(page, "e2e-admin", "AdminE2EPass!23");
  await expect(page).toHaveURL(/\/admin$/);
  await expectMailCenter(page);

  await expect(page.getByText("尚未初始化欢迎邮件模板。")).toBeVisible();
  await page.getByRole("button", { name: "初始化欢迎邮件模板" }).click();
  await expect(page.getByRole("heading", { name: "新人欢迎邮件" })).toBeVisible();
  await page.getByLabel("发件人显示名").fill("人力资源部");
  await page.getByLabel("邮件主题").fill("欢迎 {{name}}");
  await page.getByRole("textbox", { name: "富文本正文" }).fill("欢迎 {{name}}");
  await page.getByLabel("纯文本备用正文").fill("欢迎 {{name}}");
  await page.getByLabel("模板启用").check();
  await page.getByLabel("默认发送时间").fill("10:30");
  await page.getByLabel("预览员工").selectOption({ label: "今日入职员工 · E2E-MAIL-TODAY" });
  await page.getByRole("button", { name: "员工预览" }).click();
  await expect(page.getByRole("heading", { name: "欢迎 今日入职员工" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "发布新版本" }).click();
  await expect(page.getByRole("status")).toContainText("版本 1 已发布");
  await page.getByLabel("专用测试邮箱").fill("explicit-test-e2e@example.invalid");
  await page.getByRole("button", { name: "发送测试邮件" }).click();
  await expect(page.getByRole("status")).toContainText("测试邮件已加入队列：explicit-test-e2e@example.invalid");

  await page.getByRole("tab", { name: "今日待发送" }).click();
  await page.getByRole("button", { name: "测试 SMTP 连接" }).click();
  await expect(page.getByRole("status")).toContainText("SMTP 连接测试成功");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "启用自动发送" }).click();
  await expect(page.getByRole("button", { name: "停用自动发送" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "立即运行今日发送" }).click();
  await expect(page.getByRole("status")).toContainText("已创建 1 封今日邮件");

  const missed = page.getByRole("checkbox", { name: "选择历史漏发 历史漏发员工" });
  await expect(missed).not.toBeChecked();
  await missed.check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "手动发送所选历史漏发" }).click();
  await expect(page.getByRole("status")).toContainText("已创建 1 封手动邮件");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "停用自动发送" }).click();
  await expect(page.getByRole("button", { name: "启用自动发送" })).toBeVisible();

  const db = createPrismaClient(process.env.DATABASE_URL!);
  try {
    const template = await db.onboardingMailTemplate.findFirstOrThrow({ include: { currentRevision: true } });
    expect(template).toMatchObject({ enabled: true, defaultSendTime: "10:30" });
    expect(template.currentRevision).toMatchObject({ revisionNumber: 1, subject: "欢迎 {{name}}" });
    const recipient = await db.user.findUniqueOrThrow({ where: { employeeNo: "E2E-MAIL-TODAY" } });
    const base = {
      recipientId: recipient.id,
      recipientSnapshot: { id: recipient.id, employeeNo: recipient.employeeNo, name: recipient.name, email: recipient.email },
      templateRevisionId: template.currentRevision!.id,
      templateSnapshot: { revisionNumber: template.currentRevision!.revisionNumber },
      fieldSummary: {},
      ccSnapshot: [],
      attachmentSummary: [],
      scheduledAt: new Date(),
    };
    await db.onboardingMailDelivery.createMany({ data: [
      {
        ...base, status: OnboardingMailDeliveryStatus.FAILED, source: OnboardingMailDeliverySource.AUTOMATIC,
        recipientEmailSnapshot: "failed-state-e2e@example.invalid", retryable: true, failureCode: "E2E_FAILURE",
      },
      {
        ...base, status: OnboardingMailDeliveryStatus.SENT, source: OnboardingMailDeliverySource.MANUAL,
        recipientEmailSnapshot: "sent-state-e2e@example.invalid", sentAt: new Date(),
      },
      {
        ...base, status: OnboardingMailDeliveryStatus.UNKNOWN, source: OnboardingMailDeliverySource.AUTOMATIC,
        recipientEmailSnapshot: "unknown-state-e2e@example.invalid",
      },
    ] });
  } finally {
    await db.$disconnect();
  }

  await page.reload();
  await page.getByRole("tab", { name: "发送记录" }).click();
  const failedRow = page.getByText("failed-state-e2e@example.invalid").locator("xpath=ancestor::article");
  page.once("dialog", (dialog) => dialog.accept());
  await failedRow.getByRole("button", { name: "重试" }).click();
  await expect(failedRow.getByRole("button", { name: "重试" })).toHaveCount(0);

  const sentRow = page.getByText("sent-state-e2e@example.invalid").locator("xpath=ancestor::article");
  page.once("dialog", (dialog) => dialog.accept());
  await sentRow.getByRole("button", { name: "再次发送" }).click();
  await expect(sentRow.getByRole("button", { name: "再次发送" })).toHaveCount(0);

  const unknownRow = page.getByText("unknown-state-e2e@example.invalid").locator("xpath=ancestor::article");
  await expect(unknownRow).toContainText("发送调用结果未确认（可能已发出）");
  page.once("dialog", (dialog) => dialog.accept());
  await unknownRow.getByRole("button", { name: "确认已送达" }).click();
  await expect(unknownRow.getByRole("button", { name: "确认已送达" })).toHaveCount(0);

  await page.context().clearCookies();
  await login(page, "E2E-ADMIN", "RegularAdmin!23");
  await expect(page).toHaveURL(/\/admin$/);
  await expectMailCenter(page);

  await page.context().clearCookies();
  await login(page, "E2E-SEC", "EmployeeSecure!23");
  await expect(page).toHaveURL(/\/employee$/);
  await page.goto("/admin/onboarding-mail");
  await expect(page).not.toHaveURL(/\/admin\/onboarding-mail$/);
});
