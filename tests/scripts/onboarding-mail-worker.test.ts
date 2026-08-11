import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OnboardingMailDeliverySource,
  OnboardingMailTemplateKind,
  Role,
  UserSource,
} from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import type { SmtpOutcome } from "@/features/mail/smtp-transport";
import { createWelcomeDelivery } from "@/features/onboarding-mail/delivery-service";
import {
  installOnboardingMailLaunchAgent,
  parseInstallerArgs,
  renderOnboardingMailLaunchAgent,
} from "../../scripts/install-onboarding-mail-launch-agent";
import {
  parseWorkerArgs,
  runWorkerMain,
  runWorkerCli,
  workerCliDisposition,
} from "../../scripts/run-onboarding-mail-worker";
import { createTestDatabase } from "../helpers/test-db";

describe("onboarding mail worker scripts", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: string;
  beforeEach(async () => {
    testDb = await createTestDatabase();
    directory = await mkdtemp(path.join(tmpdir(), "onboarding-launch-agent-"));
  });
  afterEach(async () => {
    await testDb.cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  it("parses only explicit date/bulk flags and keeps runtime delivery disabled by default", async () => {
    expect(parseWorkerArgs(["--date", "2026-07-22", "--confirm-bulk"])).toEqual({
      localDate: "2026-07-22", confirmBulk: true,
    });
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted", providerMessageId: null, responseSummary: null, protocolStage: "POST_DATA", ccRejectedCount: 0,
    }));
    const output: string[] = [];
    const summary = await runWorkerCli([], {
      db: testDb.db,
      transport: { send },
      env: { ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false" },
      stdout: (line) => output.push(line),
      workerId: "cli-test",
    });
    expect(summary).toMatchObject({ runtimeEnabled: false, claimed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(output[0])).toMatchObject({ runtimeEnabled: false });
  });

  it("rejects bulk confirmation unless it is scoped to one explicit Shanghai calendar date", () => {
    expect(() => parseWorkerArgs(["--confirm-bulk"])).toThrow("--date");
    expect(parseWorkerArgs(["--date", "2026-07-22", "--confirm-bulk"])).toEqual({
      localDate: "2026-07-22",
      confirmBulk: true,
    });
  });

  it("confirms only one explicit date when two lookback dates both exceed the bulk threshold", async () => {
    const template = await testDb.db.onboardingMailTemplate.create({ data: {
      kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "逐日批量确认", enabled: true,
    } });
    const revision = await testDb.db.onboardingMailTemplateRevision.create({ data: {
      templateId: template.id, revisionNumber: 1, senderDisplayName: "HR",
      subject: "欢迎 {{name}}", htmlBody: "<p>欢迎 {{name}}</p>", textBody: "欢迎 {{name}}",
      fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
      styleConfig: {}, publishedBySnapshot: {},
    } });
    await testDb.db.onboardingMailTemplate.update({
      where: { id: template.id }, data: { currentRevisionId: revision.id },
    });
    await testDb.db.systemSetting.create({ data: {
      id: "default",
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: new Date("2026-07-21T00:00:00.000Z"),
    } });
    for (const [index, localDate] of ["2026-07-21", "2026-07-21", "2026-07-22", "2026-07-22"].entries()) {
      await testDb.db.user.create({ data: {
        employeeNo: `CLI-BULK-${index}`,
        name: `批量员工${index}`,
        email: `cli-bulk-${index}@example.invalid`,
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: "unused",
        hiredAt: new Date(`${localDate}T04:00:00.000Z`),
      } });
    }
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted", providerMessageId: null, responseSummary: null,
      protocolStage: "POST_DATA", ccRejectedCount: 0,
    }));

    const summary = await runWorkerCli(["--date", "2026-07-21", "--confirm-bulk"], {
      db: testDb.db,
      transport: { send },
      env: {
        ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true",
        ONBOARDING_MAIL_LOOKBACK_DAYS: "1",
        ONBOARDING_MAIL_BULK_CONFIRM_THRESHOLD: "1",
      },
      now: () => new Date("2026-07-22T04:00:00.000Z"),
      stdout: () => undefined,
      workerId: "cli-one-date-bulk",
    });

    expect(summary).toMatchObject({ enqueued: 2, claimed: 2, sent: 2 });
    expect(await testDb.db.onboardingMailDelivery.findMany({
      select: { scheduledLocalDate: true },
      orderBy: { scheduledLocalDate: "asc" },
    })).toEqual([
      { scheduledLocalDate: "2026-07-21" },
      { scheduledLocalDate: "2026-07-21" },
    ]);
  });

  it("uses an injected temporary database and fake transport for --date without backfilling before the floor", async () => {
    const employee = await testDb.db.user.create({ data: {
      employeeNo: "CLI-HISTORY", name: "历史员工", email: "history@example.invalid",
      role: Role.EMPLOYEE, sourceType: UserSource.EXCEL, passwordHash: "unused",
      hiredAt: new Date("2025-01-10T00:00:00.000Z"),
    } });
    const template = await testDb.db.onboardingMailTemplate.create({ data: {
      kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "欢迎信", enabled: true,
    } });
    const revision = await testDb.db.onboardingMailTemplateRevision.create({ data: {
      templateId: template.id, revisionNumber: 1, senderDisplayName: "HR", subject: "欢迎 {{name}}",
      htmlBody: "<p>欢迎 {{name}}</p>", textBody: "欢迎 {{name}}",
      fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
      styleConfig: {}, publishedBySnapshot: {},
    } });
    await testDb.db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
    await testDb.db.systemSetting.create({ data: {
      id: "default", onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: new Date("2026-07-22T07:00:00.000Z"),
    } });
    const send = vi.fn(async (): Promise<SmtpOutcome> => ({
      kind: "accepted", providerMessageId: null, responseSummary: null, protocolStage: "POST_DATA", ccRejectedCount: 0,
    }));
    await runWorkerCli(["--date", "2025-01-10", "--confirm-bulk"], {
      db: testDb.db,
      transport: { send },
      env: { ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true" },
      stdout: () => undefined,
      workerId: "cli-history",
      now: () => new Date("2026-07-22T08:00:00.000Z"),
    });
    expect(employee.id).toBeTruthy();
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a CLI lookback configuration above seven even while runtime delivery is disabled", async () => {
    await expect(runWorkerCli([], {
      db: testDb.db,
      transport: { send: vi.fn() },
      env: {
        ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false",
        ONBOARDING_MAIL_LOOKBACK_DAYS: "8",
      },
      stdout: () => undefined,
    })).rejects.toThrow("LOOKBACK");
  });

  it.each([
    ["ONBOARDING_MAIL_WORKER_BATCH_SIZE", "0"],
    ["ONBOARDING_MAIL_WORKER_BATCH_SIZE", "101"],
    ["ONBOARDING_MAIL_RETRY_LIMIT", "-1"],
    ["ONBOARDING_MAIL_RETRY_LIMIT", "11"],
    ["ONBOARDING_MAIL_LOOKBACK_DAYS", "0"],
    ["ONBOARDING_MAIL_LOOKBACK_DAYS", "8"],
  ])("rejects out-of-schema worker config %s=%s before transport or database work", async (key, value) => {
    let databaseReads = 0;
    const db = new Proxy({}, {
      get() {
        databaseReads += 1;
        throw new Error("database must not be touched");
      },
    }) as PrismaClient;
    const send = vi.fn();
    const close = vi.fn();

    await expect(runWorkerCli([], {
      db,
      transport: { send, close },
      env: {
        ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true",
        [key]: value,
      },
      stdout: () => undefined,
    })).rejects.toThrow();

    expect(databaseReads).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("accepts the batch-size upper boundary and closes the worker transport exactly once", async () => {
    const send = vi.fn();
    const close = vi.fn();

    const summary = await runWorkerCli([], {
      db: testDb.db,
      transport: { send, close },
      env: {
        ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false",
        ONBOARDING_MAIL_WORKER_BATCH_SIZE: "100",
      },
      stdout: () => undefined,
    });

    expect(summary.runtimeEnabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["synchronous throw", vi.fn(() => { throw new Error("sync close failed"); })],
    ["asynchronous rejection", vi.fn(async () => { throw new Error("async close failed"); })],
  ])("keeps the worker summary and disposition when transport close has a %s", async (_label, close) => {
    const summary = await runWorkerCli([], {
      db: testDb.db,
      transport: { send: vi.fn(), close },
      env: { ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "false" },
      stdout: () => undefined,
    });

    expect(summary).toMatchObject({ runtimeEnabled: false, errors: 0 });
    expect(workerCliDisposition(summary)).toEqual({ exitCode: 0, diagnostic: null });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("turns worker errors and bulk confirmation into a nonzero CLI disposition without recipient data", async () => {
    const failed = workerCliDisposition({
      errors: 2, bulkConfirmationRequired: 21, acceptedStale: 0, unknown: 0, failed: 0, stale: 0,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.diagnostic).toContain("errors=2");
    expect(failed.diagnostic).toContain("bulkConfirmationRequired=21");
    expect(failed.diagnostic).toContain("acceptedStale=0");
    expect(failed.diagnostic).not.toMatch(/@|example/i);
    expect(workerCliDisposition({
      errors: 0, bulkConfirmationRequired: null, acceptedStale: 0, unknown: 0, failed: 0, stale: 0,
    })).toEqual({
      exitCode: 0,
      diagnostic: null,
    });
  });

  it("turns an accepted result with a lost final CAS into a nonzero CLI disposition", () => {
    const failed = workerCliDisposition({
      errors: 0, bulkConfirmationRequired: null, acceptedStale: 1, unknown: 0, failed: 0, stale: 0,
    });
    expect(failed).toEqual({
      exitCode: 1,
      diagnostic: "邮件 worker 未完全成功：errors=0 bulkConfirmationRequired=0 acceptedStale=1 unknown=0 failed=0 stale=0",
    });
  });

  it.each([
    ["unknown", 1, 0, 0],
    ["failed", 0, 1, 0],
    ["stale", 0, 0, 1],
  ] as const)("uses a nonzero disposition when %s delivery outcomes require operator attention", (_label, unknown, failed, stale) => {
    expect(workerCliDisposition({
      errors: 0,
      bulkConfirmationRequired: null,
      acceptedStale: 0,
      unknown,
      failed,
      stale,
    })).toMatchObject({ exitCode: 1 });
  });

  it("validates bad runtime configuration before the real main creates a Prisma client", async () => {
    const createDb = vi.fn();

    await expect(runWorkerMain([], {
      env: {
        ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true",
        ONBOARDING_MAIL_LOOKBACK_DAYS: "8",
      },
      createDb,
      stdout: () => undefined,
      stderr: () => undefined,
    })).rejects.toThrow("LOOKBACK");

    expect(createDb).not.toHaveBeenCalled();
  });

  it.each([
    "SMTP_HOST",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ] as const)("rejects missing %s before the real main creates a Prisma client", async (missingKey) => {
    const createDb = vi.fn();
    const env: Partial<NodeJS.ProcessEnv> = {
      ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USERNAME: "mailer",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "mailer@example.invalid",
    };
    delete env[missingKey];

    await expect(runWorkerMain([], {
      env,
      createDb,
      stdout: () => undefined,
      stderr: () => undefined,
    })).rejects.toThrow(missingKey.replace("SMTP_", ""));

    expect(createDb).not.toHaveBeenCalled();
  });

  it("writes uncaught delivery diagnostics to the injected stderr without leaking email", async () => {
    const employee = await testDb.db.user.create({ data: {
      employeeNo: "CLI-ERROR", name: "异常员工", email: "cli-error@example.invalid",
      role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash: "unused",
      hiredAt: new Date("2026-07-22T04:00:00.000Z"),
    } });
    const template = await testDb.db.onboardingMailTemplate.create({ data: {
      kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME, name: "异常欢迎信", enabled: true,
    } });
    const revision = await testDb.db.onboardingMailTemplateRevision.create({ data: {
      templateId: template.id, revisionNumber: 1, senderDisplayName: "HR",
      subject: "欢迎 {{name}}", htmlBody: "<p>欢迎 {{name}}</p>", textBody: "欢迎 {{name}}",
      fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
      styleConfig: {}, publishedBySnapshot: {},
    } });
    await testDb.db.onboardingMailTemplate.update({
      where: { id: template.id }, data: { currentRevisionId: revision.id },
    });
    const delivery = await createWelcomeDelivery({
      source: OnboardingMailDeliverySource.MANUAL,
      recipientId: employee.id,
      templateRevisionId: revision.id,
      scheduledLocalDate: null,
      scheduledAt: new Date("2026-07-22T04:00:00.000Z"),
    }, { db: testDb.db, now: () => new Date("2026-07-22T04:00:00.000Z") });
    const realDelegate = testDb.db.onboardingMailDelivery;
    const failingDelegate = new Proxy(realDelegate, {
      get(target, property) {
        if (property === "findFirst") {
          return async () => { throw new Error("processing cli-error@example.invalid"); };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testDb.db, {
      get(target, property) {
        if (property === "onboardingMailDelivery") return failingDelegate;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const stderr: string[] = [];

    const summary = await runWorkerCli([], {
      db,
      transport: { send: vi.fn() },
      env: { ONBOARDING_MAIL_AUTOMATION_RUNTIME_ENABLED: "true" },
      now: () => new Date("2026-07-22T04:00:00.000Z"),
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
      workerId: "cli-error-worker",
    });

    expect(summary.errors).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0])).toEqual({
      deliveryId: delivery.id,
      code: "UNCAUGHT_PROCESSING_ERROR",
      errorType: "Error",
      errorSummary: "processing [redacted-email]",
    });
    expect(stderr.join("\n")).not.toContain("cli-error@example.invalid");
  });

  it("renders a plist without secrets and writes it only after explicit confirmation to an explicit allowed path", async () => {
    const outputPath = path.join(directory, "org.cohortharbor.onboarding-mail.plist");
    const input = {
      label: "org.cohortharbor.onboarding-mail",
      outputPath,
      projectDir: "/Users/example/onboarding-platform",
      pnpmPath: "/opt/pnpm/bin/pnpm",
      logPath: "/Users/example/logs/onboarding-worker<&>.log",
      intervalSeconds: 300,
    };
    const rendered = renderOnboardingMailLaunchAgent(input);
    expect(rendered).toContain("mail:worker");
    expect(rendered).toContain("/Users/example/onboarding-platform");
    expect(rendered).toContain(
      "<key>StandardOutPath</key><string>/Users/example/logs/onboarding-worker&lt;&amp;&gt;.log</string>",
    );
    expect(rendered).toContain(
      "<key>StandardErrorPath</key><string>/Users/example/logs/onboarding-worker&lt;&amp;&gt;.log</string>",
    );
    expect(rendered).not.toMatch(/SMTP_PASSWORD|smtp-secret/);
    expect(() => renderOnboardingMailLaunchAgent({
      ...input,
      logPath: "relative/worker.log",
    })).toThrow("日志路径");

    await expect(installOnboardingMailLaunchAgent({ ...input, confirmed: false }, { allowedRoot: directory }))
      .rejects.toThrow("确认");
    await expect(access(outputPath)).rejects.toBeTruthy();
    await installOnboardingMailLaunchAgent({ ...input, confirmed: true }, { allowedRoot: directory });
    expect(await readFile(outputPath, "utf8")).toBe(rendered);
  });

  it("requires an explicit absolute --log-path in LaunchAgent CLI arguments", () => {
    const baseArgs = [
      "--output", "/Users/example/Library/LaunchAgents/org.cohortharbor.onboarding-mail.plist",
      "--project-dir", "/Users/example/onboarding-platform",
      "--pnpm-path", "/opt/pnpm/bin/pnpm",
    ];

    expect(() => parseInstallerArgs(baseArgs)).toThrow("--log-path");
    expect(() => parseInstallerArgs([...baseArgs, "--log-path", "relative/worker.log"]))
      .toThrow("日志路径");
    expect(parseInstallerArgs([
      ...baseArgs,
      "--log-path", "/Users/example/Library/Logs/onboarding-worker.log",
    ])).toMatchObject({
      logPath: "/Users/example/Library/Logs/onboarding-worker.log",
    });
  });
});
