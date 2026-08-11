import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOnboardingMailAssetsRoute, mailAttachmentMaxBytes } from "@/app/api/admin/onboarding-mail/assets/route";
import { createOnboardingMailAssetPreviewRoute } from "@/app/api/admin/onboarding-mail/assets/[assetId]/preview/route";
import { createOnboardingMailAutomationRoute } from "@/app/api/admin/onboarding-mail/automation/route";
import { createOnboardingMailCcSearchRoute } from "@/app/api/admin/onboarding-mail/cc-search/route";
import { createOnboardingMailConfirmationRoute } from "@/app/api/admin/onboarding-mail/confirmations/route";
import { createOnboardingMailFieldsRoute } from "@/app/api/admin/onboarding-mail/fields/route";
import { createOnboardingMailManualSendRoute } from "@/app/api/admin/onboarding-mail/manual-send/route";
import { createOnboardingMailEnqueueTodayRoute } from "@/app/api/admin/onboarding-mail/enqueue-today/route";
import { createOnboardingMailDeliveriesRoute } from "@/app/api/admin/onboarding-mail/deliveries/route";
import { createOnboardingMailOverviewRoute } from "@/app/api/admin/onboarding-mail/overview/route";
import { createOnboardingMailPreviewRoute } from "@/app/api/admin/onboarding-mail/preview/route";
import { createOnboardingMailRevisionsRoute } from "@/app/api/admin/onboarding-mail/revisions/route";
import { createOnboardingMailResendRoute } from "@/app/api/admin/onboarding-mail/resend/route";
import { createOnboardingMailRetryRoute } from "@/app/api/admin/onboarding-mail/retry/route";
import { createOnboardingMailSmtpTestRoute } from "@/app/api/admin/onboarding-mail/smtp-test/route";
import { createOnboardingMailTestSendRoute } from "@/app/api/admin/onboarding-mail/test-send/route";
import { createOnboardingMailTemplatesRoute } from "@/app/api/admin/onboarding-mail/templates/route";
import { createOnboardingMailUnknownResolutionRoute } from "@/app/api/admin/onboarding-mail/unknown/[id]/resolve/route";
import {
  OnboardingMailDeliverySource,
  OnboardingMailDeliveryStatus,
  OnboardingMailTemplateKind,
  Role,
  SessionViewMode,
  UserSource,
  UserStatus,
} from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { createSession } from "@/features/auth/session";
import { createWelcomeDelivery } from "@/features/onboarding-mail/delivery-service";
import type { TemplateDraft } from "@/features/onboarding-mail/template-schemas";
import { createTestDatabase } from "../helpers/test-db";
import { validPng } from "../fixtures/portal-images";

const now = new Date("2026-07-22T02:00:00.000Z");

describe("onboarding-mail administration routes", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let privateRoot: string;
  const tokens = new Map<string, string>();
  const ids = new Map<string, string>();

  beforeEach(async () => {
    testDb = await createTestDatabase();
    privateRoot = await mkdtemp(path.join(tmpdir(), "cohort-harbor-mail-routes-"));
    const passwordHash = await hashPassword("MailRoutes123");
    for (const [name, role, viewMode] of [
      ["admin", Role.ADMIN, SessionViewMode.ADMIN],
      ["super", Role.SUPER_ADMIN, SessionViewMode.ADMIN],
      ["employee", Role.EMPLOYEE, SessionViewMode.EMPLOYEE],
      ["admin-employee-view", Role.ADMIN, SessionViewMode.EMPLOYEE],
    ] as const) {
      const user = await testDb.db.user.create({
        data: {
          employeeNo: `MAIL-ROUTE-${name}`,
          name,
          role,
          sourceType: UserSource.MANUAL,
          mustChangePassword: false,
          passwordHash,
        },
      });
      ids.set(name, user.id);
      tokens.set(name, (await createSession(testDb.db, user.id, { viewMode })).token);
    }
  });

  afterEach(async () => { await testDb.cleanup(); await rm(privateRoot, { recursive: true, force: true }); });

  function request(
    path: string,
    name: string,
    method: "GET" | "PATCH" | "POST" = "GET",
    body?: unknown,
    origin = "http://localhost:3000",
  ) {
    return new Request(`http://localhost:3000${path}`, {
      method,
      headers: {
        cookie: `cohort_harbor_session=${tokens.get(name)}`,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function seedPublishedTemplate() {
    const template = await testDb.db.onboardingMailTemplate.create({ data: {
      kind: OnboardingMailTemplateKind.NEW_HIRE_WELCOME,
      name: "新人欢迎信",
      enabled: true,
    } });
    const revision = await testDb.db.onboardingMailTemplateRevision.create({ data: {
      templateId: template.id,
      revisionNumber: 1,
      senderDisplayName: "人力资源部",
      subject: "欢迎 {{name}}",
      htmlBody: "<p>欢迎 {{name}}</p>",
      textBody: "欢迎 {{name}}",
      fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
      styleConfig: {},
      publishedBySnapshot: {},
    } });
    await testDb.db.onboardingMailTemplate.update({ where: { id: template.id }, data: { currentRevisionId: revision.id } });
    return { template, revision };
  }

  function draft(templateId: string, overrides: Partial<TemplateDraft> = {}): TemplateDraft {
    return {
      templateId,
      senderDisplayName: "人力资源部",
      subject: "欢迎 {{name}}",
      htmlBody: "<p>欢迎 <strong>{{name}}</strong></p>",
      textBody: "欢迎 {{name}}",
      fieldConfig: [{ key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true }],
      styleConfig: { accent: "#007bd8" },
      attachments: [],
      ccEntries: [],
      ...overrides,
    };
  }

  async function seedEmployee(index: number, hiredAt = now) {
    return testDb.db.user.create({ data: {
      employeeNo: `MAIL-E-${index}`,
      name: `新人 ${index}`,
      email: `new-${index}@example.invalid`,
      hiredAt,
      role: Role.EMPLOYEE,
      sourceType: UserSource.MANUAL,
      passwordHash: "unused",
    } });
  }

  it("gives ADMIN and SUPER_ADMIN equal overview access while denying every employee view", async () => {
    const route = createOnboardingMailOverviewRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
      smtpConfigured: true,
    });

    for (const name of ["admin", "super"]) {
      const response = await route.GET(request("/api/admin/onboarding-mail/overview", name));
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        ok: true,
        smtp: { configured: true },
        automation: { enabled: false },
        today: { localDate: "2026-07-22", matched: 0, eligible: 0, excluded: 0 },
      });
      expect(JSON.stringify(payload)).not.toMatch(/password|secret|username|smtp\.example/i);
    }

    expect((await route.GET(request("/api/admin/onboarding-mail/overview", "employee"))).status).toBe(403);
    expect((await route.GET(request("/api/admin/onboarding-mail/overview", "admin-employee-view"))).status).toBe(403);
  });

  it("requires same-origin mutations before changing automation state", async () => {
    const route = createOnboardingMailAutomationRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
      smtpTestMaxAgeMs: 15 * 60_000,
    });
    const before = await testDb.db.systemSetting.findUnique({ where: { id: "default" } });

    const response = await route.PATCH(request(
      "/api/admin/onboarding-mail/automation",
      "admin",
      "PATCH",
      { enabled: true, confirmed: true, displayedRecipientCount: 0 },
      "https://attacker.invalid",
    ));

    expect(response.status).toBe(403);
    expect(await testDb.db.systemSetting.findUnique({ where: { id: "default" } })).toEqual(before);
  });

  it("gates automation on a recent SMTP test, an enabled published template, and the exact displayed count token", async () => {
    const route = createOnboardingMailAutomationRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
      smtpTestMaxAgeMs: 15 * 60_000,
    });
    const missingSmtp = await route.PATCH(request("/api/admin/onboarding-mail/automation", "admin", "PATCH", {
      enabled: true, confirmed: true, displayedRecipientCount: 0,
    }));
    expect(missingSmtp.status).toBe(409);
    expect((await missingSmtp.json()).code).toBe("SMTP_TEST_REQUIRED");

    await testDb.db.auditLog.create({ data: {
      actorId: ids.get("admin"), actorSnapshot: {}, action: "ONBOARDING_MAIL_SMTP_TEST", result: "SUCCESS", createdAt: now,
    } });
    const missingTemplate = await route.PATCH(request("/api/admin/onboarding-mail/automation", "admin", "PATCH", {
      enabled: true, confirmed: true, displayedRecipientCount: 0,
    }));
    expect(missingTemplate.status).toBe(409);
    expect((await missingTemplate.json()).code).toBe("PUBLISHED_TEMPLATE_REQUIRED");

    await seedPublishedTemplate();
    await seedEmployee(89);
    const overview = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const overviewPayload = await (await overview.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();
    expect(overviewPayload.smtp.lastSuccessfulTestAt).toBe(now.toISOString());
    expect(overviewPayload.automation.confirmRecipientCount).toBe(1);
    const rejected = await route.PATCH(request("/api/admin/onboarding-mail/automation", "admin", "PATCH", {
      enabled: true,
      confirmed: true,
      displayedRecipientCount: 0,
      confirmationToken: overviewPayload.confirmations.enableAutomation.token,
    }));
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("CONFIRMATION_MISMATCH");

    const accepted = await route.PATCH(request("/api/admin/onboarding-mail/automation", "admin", "PATCH", {
      enabled: true,
      confirmed: true,
      displayedRecipientCount: 1,
      confirmationToken: overviewPayload.confirmations.enableAutomation.token,
    }));
    expect(accepted.status).toBe(200);
    expect(await testDb.db.systemSetting.findUniqueOrThrow({ where: { id: "default" } })).toMatchObject({
      onboardingMailAutomationEnabled: true,
      onboardingMailAutomationEnabledAt: now,
    });
  });

  it("requires a count/date-bound short-lived token before enqueueing 21 automatic deliveries", async () => {
    await seedPublishedTemplate();
    await testDb.db.systemSetting.create({ data: {
      id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: now,
    } });
    await Promise.all(Array.from({ length: 21 }, (_, index) => seedEmployee(index)));
    const overview = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const overviewPayload = await (await overview.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();
    expect(overviewPayload.today).toMatchObject({ matched: 21, eligible: 21, excluded: 0 });
    const route = createOnboardingMailEnqueueTodayRoute({
      db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20,
    });
    const rejected = await route.POST(request("/api/admin/onboarding-mail/enqueue-today", "admin", "POST", {
      localDate: "2026-07-22", confirmed: true, displayedRecipientCount: 21,
    }));
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("BULK_CONFIRMATION_REQUIRED");

    const accepted = await route.POST(request("/api/admin/onboarding-mail/enqueue-today", "admin", "POST", {
      localDate: "2026-07-22",
      confirmed: true,
      displayedRecipientCount: 21,
      confirmationToken: overviewPayload.confirmations.enqueueToday.token,
    }));
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).summary).toMatchObject({ enqueued: 21, eligible: 21 });
  });

  it("aborts with zero automatic inserts when eligibility changes after signed-count verification", async () => {
    await seedPublishedTemplate();
    await testDb.db.systemSetting.create({ data: {
      id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: now,
    } });
    await seedEmployee(605);
    const overview = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const overviewPayload = await (await overview.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();
    const originalFindSetting = testDb.db.systemSetting.findUnique.bind(testDb.db.systemSetting);
    let settingReads = 0;
    vi.spyOn(testDb.db.systemSetting, "findUnique").mockImplementation((args) => {
      settingReads += 1;
      if (settingReads !== 2) return originalFindSetting(args);
      return (async () => {
        await seedEmployee(606);
        return originalFindSetting(args);
      })() as unknown as ReturnType<typeof originalFindSetting>;
    });
    const route = createOnboardingMailEnqueueTodayRoute({
      db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 0,
    });

    const response = await route.POST(request("/api/admin/onboarding-mail/enqueue-today", "admin", "POST", {
      localDate: "2026-07-22", confirmed: true, displayedRecipientCount: 1,
      confirmationToken: overviewPayload.confirmations.enqueueToday.token,
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CONFIRMATION_MISMATCH");
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.AUTOMATIC } })).toBe(0);
  });

  it("records SMTP test success without leaking injected credentials or server details", async () => {
    const testConnection = vi.fn(async () => ({ ok: true as const }));
    const route = createOnboardingMailSmtpTestRoute({ db: testDb.db, now: () => now, testConnection });
    const response = await route.POST(request("/api/admin/onboarding-mail/smtp-test", "super", "POST", {}));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/password|secret|smtp\.example|username/i);
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(await testDb.db.auditLog.findFirst({ where: { action: "ONBOARDING_MAIL_SMTP_TEST", result: "SUCCESS" } })).toBeTruthy();
  });

  it("queues test mail only to the explicitly entered test mailbox", async () => {
    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(90);
    const route = createOnboardingMailTestSendRoute({ db: testDb.db, now: () => now });
    const inferred = await route.POST(request("/api/admin/onboarding-mail/test-send", "admin", "POST", {
      employeeId: employee.id,
      templateRevisionId: revision.id,
    }));
    expect(inferred.status).toBe(400);
    const response = await route.POST(request("/api/admin/onboarding-mail/test-send", "admin", "POST", {
      employeeId: employee.id,
      templateRevisionId: revision.id,
      testMailbox: "qa-mailbox@example.invalid",
      confirmed: true,
    }));
    expect(response.status).toBe(201);
    expect(await testDb.db.onboardingMailDelivery.findFirstOrThrow({ where: { source: OnboardingMailDeliverySource.TEST } })).toMatchObject({
      recipientId: null,
      recipientEmailSnapshot: "qa-mailbox@example.invalid",
      ccSnapshot: [],
    });
  });

  it("keeps UNKNOWN out of retry and exposes exactly two audited resolution actions", async () => {
    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(91);
    const delivery = await createWelcomeDelivery({
      source: OnboardingMailDeliverySource.MANUAL,
      recipientId: employee.id,
      templateRevisionId: revision.id,
      scheduledLocalDate: null,
      scheduledAt: now,
      actorId: ids.get("admin"),
    }, { db: testDb.db, now: () => now });
    await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN } });

    const retry = createOnboardingMailRetryRoute({ db: testDb.db, now: () => now });
    const retryResponse = await retry.POST(request("/api/admin/onboarding-mail/retry", "admin", "POST", { deliveryIds: [delivery.id], confirmed: true }));
    expect(retryResponse.status).toBe(400);
    expect((await retryResponse.json()).code).toBe("UNKNOWN_NOT_RETRYABLE");

    const resolve = createOnboardingMailUnknownResolutionRoute({ db: testDb.db, now: () => now }, delivery.id);
    const resolution = await resolve.POST(request(`/api/admin/onboarding-mail/unknown/${delivery.id}/resolve`, "admin", "POST", {
      action: "CONFIRMED_FAILED_RESEND", note: "收件人确认未收到", confirmed: true,
    }));
    expect(resolution.status).toBe(201);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { resendOfId: delivery.id } })).toBe(1);
    expect(await testDb.db.auditLog.findFirst({ where: { action: "ONBOARDING_MAIL_UNKNOWN_CONFIRMED_FAILED_RESEND" } })).toBeTruthy();
  });

  it("rolls back an UNKNOWN operator resolution when its required audit cannot be written", async () => {
    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(93);
    const delivery = await createWelcomeDelivery({ source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id, templateRevisionId: revision.id, scheduledLocalDate: null, scheduledAt: now }, { db: testDb.db, now: () => now });
    await testDb.db.onboardingMailDelivery.update({ where: { id: delivery.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN } });
    await testDb.db.$executeRawUnsafe(`
      CREATE TRIGGER reject_unknown_resolution_audit
      BEFORE INSERT ON "AuditLog"
      WHEN NEW.action LIKE 'ONBOARDING_MAIL_UNKNOWN_%'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END
    `);
    const route = createOnboardingMailUnknownResolutionRoute({ db: testDb.db, now: () => now }, delivery.id);
    const response = await route.POST(request(`/api/admin/onboarding-mail/unknown/${delivery.id}/resolve`, "admin", "POST", { action: "CONFIRMED_DELIVERED", note: "人工核实", confirmed: true }));
    expect(response.status).toBe(400);
    expect(await testDb.db.onboardingMailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ unknownResolution: null, unknownResolvedAt: null });
  });

  it("returns identity-labelled CC candidates for duplicate names", async () => {
    await testDb.db.user.createMany({ data: [
      { employeeNo: "CC-001", name: "李晨", email: "li-1@example.invalid", passwordHash: "unused", sourceType: UserSource.MANUAL },
      { employeeNo: "CC-002", name: "李晨", email: "li-2@example.invalid", passwordHash: "unused", sourceType: UserSource.MANUAL },
    ] });
    const route = createOnboardingMailCcSearchRoute({ db: testDb.db });
    const response = await route.GET(request("/api/admin/onboarding-mail/cc-search?q=%E6%9D%8E%E6%99%A8", "admin"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates.map((item: { label: string }) => item.label)).toEqual([
      "李晨（CC-001 · li-1@example.invalid）",
      "李晨（CC-002 · li-2@example.invalid）",
    ]);
  });

  it("supports validated draft save, employee preview, publish, immutable revision history, and field management", async () => {
    const templates = createOnboardingMailTemplatesRoute({ db: testDb.db });
    const initialized = await templates.POST(request("/api/admin/onboarding-mail/templates", "admin", "POST", { name: "新人欢迎信" }));
    expect(initialized.status).toBe(201);
    const template = (await initialized.json()).template as { id: string };
    const malformed = await templates.PATCH(request("/api/admin/onboarding-mail/templates", "admin", "PATCH", { draft: { ...draft(template.id), subject: "" } }));
    expect(malformed.status).toBe(400);
    const invalidMaterial = await templates.PATCH(request("/api/admin/onboarding-mail/templates", "admin", "PATCH", {
      draft: draft(template.id, { attachments: [{
        role: "ATTACHMENT", materialVersionId: "missing-material-version", displayName: "missing.pdf", sortOrder: 1,
      }] }),
      enabled: false,
      defaultSendTime: "09:00",
    }));
    expect(invalidMaterial.status).toBe(400);
    expect(await invalidMaterial.json()).toMatchObject({ code: "INVALID_MATERIAL_VERSION" });

    const saved = await templates.PATCH(request("/api/admin/onboarding-mail/templates", "super", "PATCH", { draft: draft(template.id), enabled: true, defaultSendTime: "09:00" }));
    expect(saved.status).toBe(200);
    const employee = await seedEmployee(92);
    const preview = createOnboardingMailPreviewRoute({ db: testDb.db, now: () => now });
    const previewResponse = await preview.POST(request("/api/admin/onboarding-mail/preview", "admin", "POST", { draft: draft(template.id), employeeId: employee.id }));
    expect(previewResponse.status).toBe(200);
    expect((await previewResponse.json()).preview).toMatchObject({ subject: "欢迎 新人 92", recipient: { employeeId: employee.id } });

    const revisions = createOnboardingMailRevisionsRoute({ db: testDb.db });
    expect((await revisions.POST(request("/api/admin/onboarding-mail/revisions", "admin", "POST", {
      draft: draft(template.id), confirmed: true, enabled: true, defaultSendTime: "10:30",
    }))).status).toBe(201);
    expect(await testDb.db.onboardingMailTemplate.findUniqueOrThrow({ where: { id: template.id } })).toMatchObject({
      enabled: true, defaultSendTime: "10:30",
    });
    expect((await revisions.POST(request("/api/admin/onboarding-mail/revisions", "super", "POST", { draft: draft(template.id, { subject: "第二版 {{name}}" }), confirmed: true }))).status).toBe(201);
    const history = await (await revisions.GET(request(`/api/admin/onboarding-mail/revisions?templateId=${template.id}`, "admin"))).json();
    expect(history.revisions.map((item: { revisionNumber: number }) => item.revisionNumber)).toEqual([2, 1]);

    const fields = createOnboardingMailFieldsRoute({ db: testDb.db });
    const fieldResponse = await fields.PATCH(request("/api/admin/onboarding-mail/fields", "admin", "PATCH", {
      fields: [
        { key: "name", kind: "BUILTIN", label: "姓名", enabled: true, sortOrder: 1, required: true },
        { key: "custom.orientation", kind: "CONSTANT", label: "报到提示", enabled: true, sortOrder: 11, required: false, constantValue: "请到前台报到" },
      ],
    }));
    expect(fieldResponse.status).toBe(200);
    const savedFields = (await fieldResponse.json()).fields;
    expect(savedFields).toContainEqual({
      key: "custom.orientation",
      kind: "CONSTANT",
      label: "报到提示",
      enabled: true,
      sortOrder: 11,
      required: false,
      dateFormat: null,
      constantValue: "请到前台报到",
    });
    expect(savedFields[0]).not.toHaveProperty("id");
    expect(savedFields[0]).not.toHaveProperty("updatedBySnapshot");
    const fieldListResponse = await fields.GET(request("/api/admin/onboarding-mail/fields", "super"));
    expect(fieldListResponse.status).toBe(200);
    const fieldList = await fieldListResponse.json();
    expect(fieldList.fields).toContainEqual({
      key: "custom.orientation",
      kind: "CONSTANT",
      label: "报到提示",
      enabled: true,
      sortOrder: 11,
      required: false,
      dateFormat: null,
      constantValue: "请到前台报到",
    });
    expect(fieldList.fields[0]).not.toHaveProperty("id");
    expect(fieldList.fields[0]).not.toHaveProperty("updatedBySnapshot");
    expect(await testDb.db.onboardingMailField.findUnique({ where: { key: "custom.orientation" } })).toMatchObject({ builtIn: false, constantValue: "请到前台报到" });
  });

  it("rolls back draft, attachments, CC and audit when template settings fail late", async () => {
    const templates = createOnboardingMailTemplatesRoute({ db: testDb.db });
    const initialized = await templates.POST(request("/api/admin/onboarding-mail/templates", "admin", "POST", { name: "新人欢迎信" }));
    const template = (await initialized.json()).template as { id: string };
    expect((await templates.PATCH(request("/api/admin/onboarding-mail/templates", "admin", "PATCH", {
      draft: draft(template.id), enabled: false, defaultSendTime: "09:00",
    }))).status).toBe(200);
    const assets = createOnboardingMailAssetsRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    const form = new FormData();
    form.set("role", "INLINE_BODY");
    form.set("contentId", "late-image");
    form.set("file", new File([validPng()], "late.png", { type: "image/png" }));
    const upload = await assets.POST(new Request("http://localhost:3000/api/admin/onboarding-mail/assets", {
      method: "POST", headers: { cookie: `cohort_harbor_session=${tokens.get("admin")}`, origin: "http://localhost:3000" }, body: form,
    }));
    const asset = (await upload.json()).asset as { id: string };
    const auditCount = await testDb.db.auditLog.count({ where: { action: "ONBOARDING_MAIL_DRAFT_SAVE" } });
    await testDb.db.$executeRawUnsafe(`
      CREATE TRIGGER reject_late_template_settings
      BEFORE UPDATE ON "OnboardingMailTemplate"
      WHEN NEW.enabled = 1 AND NEW.defaultSendTime = '10:30'
      BEGIN
        SELECT RAISE(ABORT, 'late settings failure');
      END
    `);

    const response = await templates.PATCH(request("/api/admin/onboarding-mail/templates", "admin", "PATCH", {
      draft: draft(template.id, {
        subject: "不得提交 {{name}}",
        htmlBody: '<p>不得提交</p><img src="cid:late-image" alt="late">',
        attachments: [{ role: "INLINE_BODY", fileAssetId: asset.id, displayName: "late.png", contentId: "late-image", sortOrder: 1 }],
        ccEntries: [{ kind: "EMAIL", email: "external@example.invalid", sortOrder: 1 }],
      }),
      enabled: true,
      defaultSendTime: "10:30",
    }));

    expect(response.status).toBe(400);
    expect(await testDb.db.onboardingMailTemplate.findUniqueOrThrow({
      where: { id: template.id }, include: { draftAttachments: true, draftCcEntries: true },
    })).toMatchObject({
      enabled: false, defaultSendTime: "09:00", draftSubject: "欢迎 {{name}}", draftAttachments: [], draftCcEntries: [],
    });
    expect(await testDb.db.auditLog.count({ where: { action: "ONBOARDING_MAIL_DRAFT_SAVE" } })).toBe(auditCount);
  });

  it("keeps past-missed sends manual-only and applies the 21-recipient token to manual and resend creation", async () => {
    const { revision } = await seedPublishedTemplate();
    const past = new Date("2026-07-21T02:00:00.000Z");
    const employees = await Promise.all(Array.from({ length: 21 }, (_, index) => seedEmployee(200 + index, past)));
    const manual = createOnboardingMailManualSendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const body = { employeeIds: employees.map((item) => item.id), localDate: "2026-07-21", displayedRecipientCount: 21, confirmed: true };
    const rejected = await manual.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", body));
    expect(rejected.status).toBe(409);
    const confirmations = createOnboardingMailConfirmationRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret" });
    const manualConfirmation = await confirmations.POST(request("/api/admin/onboarding-mail/confirmations", "admin", "POST", {
      action: "MANUAL_SEND", localDate: "2026-07-21", selectedIds: employees.map((item) => item.id),
    }));
    expect(manualConfirmation.status).toBe(200);
    const manualToken = (await manualConfirmation.json()).confirmationToken as string;
    const accepted = await manual.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", { ...body, confirmationToken: manualToken }));
    expect(accepted.status).toBe(201);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.MANUAL, scheduledLocalDate: null } })).toBe(21);
    await testDb.db.onboardingMailDelivery.updateMany({ where: { source: OnboardingMailDeliverySource.MANUAL }, data: { status: OnboardingMailDeliveryStatus.SENT, sentAt: now } });

    const originals = await testDb.db.onboardingMailDelivery.findMany({ where: { source: OnboardingMailDeliverySource.MANUAL }, select: { id: true } });
    const resend = createOnboardingMailResendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const resendBody = { deliveryIds: originals.map((item) => item.id), localDate: "2026-07-22", displayedRecipientCount: 21, confirmed: true };
    expect((await resend.POST(request("/api/admin/onboarding-mail/resend", "super", "POST", resendBody))).status).toBe(409);
    const resendConfirmation = await confirmations.POST(request("/api/admin/onboarding-mail/confirmations", "super", "POST", {
      action: "RESEND", localDate: "2026-07-22", selectedIds: originals.map((item) => item.id),
    }));
    expect(resendConfirmation.status).toBe(200);
    const resendToken = (await resendConfirmation.json()).confirmationToken as string;
    expect((await resend.POST(request("/api/admin/onboarding-mail/resend", "super", "POST", { ...resendBody, confirmationToken: resendToken }))).status).toBe(201);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.RESEND } })).toBe(21);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.AUTOMATIC } })).toBe(0);
    expect(revision.id).toBeTruthy();
  });

  it("rejects administrator, disabled, and departed ids from manual confirmation and delivery creation", async () => {
    await seedPublishedTemplate();
    const past = new Date("2026-07-21T02:00:00.000Z");
    const passwordHash = await hashPassword("MailCandidate123");
    const candidates = await Promise.all([
      testDb.db.user.create({ data: {
        employeeNo: "MAIL-INELIGIBLE-ADMIN",
        name: "不应收件的管理员",
        email: "admin-recipient@example.invalid",
        hiredAt: past,
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash,
      } }),
      testDb.db.user.create({ data: {
        employeeNo: "MAIL-INELIGIBLE-DISABLED",
        name: "已停用员工",
        email: "disabled-recipient@example.invalid",
        hiredAt: past,
        role: Role.EMPLOYEE,
        enabled: false,
        sourceType: UserSource.MANUAL,
        passwordHash,
      } }),
      testDb.db.user.create({ data: {
        employeeNo: "MAIL-INELIGIBLE-DEPARTED",
        name: "已离职员工",
        email: "departed-recipient@example.invalid",
        hiredAt: past,
        role: Role.EMPLOYEE,
        status: UserStatus.DEPARTED,
        sourceType: UserSource.MANUAL,
        passwordHash,
      } }),
    ]);
    const confirmations = createOnboardingMailConfirmationRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
    });
    const manual = createOnboardingMailManualSendRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
      bulkThreshold: 20,
    });

    for (const candidate of candidates) {
      const confirmation = await confirmations.POST(request(
        "/api/admin/onboarding-mail/confirmations",
        "admin",
        "POST",
        { action: "MANUAL_SEND", localDate: "2026-07-21", selectedIds: [candidate.id] },
      ));
      const confirmationPayload = await confirmation.json();
      expect(confirmation.status, candidate.employeeNo).toBe(400);
      expect(confirmationPayload, candidate.employeeNo).toMatchObject({ code: "RECIPIENT_MISMATCH" });
      expect(confirmationPayload, candidate.employeeNo).not.toHaveProperty("count");
      expect(confirmationPayload, candidate.employeeNo).not.toHaveProperty("confirmationToken");

      const delivery = await manual.POST(request(
        "/api/admin/onboarding-mail/manual-send",
        "admin",
        "POST",
        {
          employeeIds: [candidate.id],
          localDate: "2026-07-21",
          displayedRecipientCount: 1,
          confirmed: true,
        },
      ));
      expect(delivery.status, candidate.employeeNo).toBe(400);
      expect(await delivery.json(), candidate.employeeNo).toMatchObject({ code: "RECIPIENT_MISMATCH" });
    }

    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
  });

  it("rechecks the same recipient qualification after confirmation before creating a manual delivery", async () => {
    await seedPublishedTemplate();
    const employee = await seedEmployee(609, new Date("2026-07-21T02:00:00.000Z"));
    const confirmations = createOnboardingMailConfirmationRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
    });
    const confirmation = await confirmations.POST(request(
      "/api/admin/onboarding-mail/confirmations",
      "admin",
      "POST",
      { action: "MANUAL_SEND", localDate: "2026-07-21", selectedIds: [employee.id] },
    ));
    expect(confirmation.status).toBe(200);
    const confirmationToken = (await confirmation.json()).confirmationToken as string;
    await testDb.db.user.update({ where: { id: employee.id }, data: { role: Role.ADMIN } });

    const manual = createOnboardingMailManualSendRoute({
      db: testDb.db,
      now: () => now,
      bulkConfirmationSecret: "route-test-secret",
      bulkThreshold: 0,
    });
    const response = await manual.POST(request(
      "/api/admin/onboarding-mail/manual-send",
      "admin",
      "POST",
      {
        employeeIds: [employee.id],
        localDate: "2026-07-21",
        displayedRecipientCount: 1,
        confirmed: true,
        confirmationToken,
      },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "RECIPIENT_MISMATCH" });
    expect(await testDb.db.onboardingMailDelivery.count()).toBe(0);
  });

  it("rejects a duplicate past-missed manual submission without creating another delivery", async () => {
    await seedPublishedTemplate();
    const employee = await seedEmployee(600, new Date("2026-07-21T02:00:00.000Z"));
    const route = createOnboardingMailManualSendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const body = { employeeIds: [employee.id], localDate: "2026-07-21", displayedRecipientCount: 1, confirmed: true };

    expect((await route.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", body))).status).toBe(201);
    const duplicate = await route.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", body));

    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("MANUAL_DELIVERY_EXISTS");
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id } })).toBe(1);
  });

  it("creates exactly one manual delivery when two valid past-missed requests race", async () => {
    await seedPublishedTemplate();
    const employee = await seedEmployee(607, new Date("2026-07-21T02:00:00.000Z"));
    const route = createOnboardingMailManualSendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const body = { employeeIds: [employee.id], localDate: "2026-07-21", displayedRecipientCount: 1, confirmed: true };

    const responses = await Promise.all([
      route.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", body)),
      route.POST(request("/api/admin/onboarding-mail/manual-send", "super", "POST", body)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id } })).toBe(1);
  });

  it("enforces one non-cancelled manual delivery per recipient at the database boundary", async () => {
    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(608, new Date("2026-07-21T02:00:00.000Z"));
    const input = {
      source: OnboardingMailDeliverySource.MANUAL,
      recipientId: employee.id,
      templateRevisionId: revision.id,
      scheduledLocalDate: null,
      scheduledAt: now,
    };
    const first = await createWelcomeDelivery(input, { db: testDb.db, now: () => now });

    await expect(createWelcomeDelivery(input, { db: testDb.db, now: () => now })).rejects.toBeDefined();
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id } })).toBe(1);

    await testDb.db.onboardingMailDelivery.update({ where: { id: first.id }, data: { status: OnboardingMailDeliveryStatus.CANCELLED } });
    await expect(createWelcomeDelivery(input, { db: testDb.db, now: () => now })).resolves.toMatchObject({ recipientId: employee.id });
  });

  it("rolls back the entire past-missed manual batch when row two cannot be inserted", async () => {
    await seedPublishedTemplate();
    const employees = await Promise.all([601, 602].map((index) => seedEmployee(index, new Date("2026-07-21T02:00:00.000Z"))));
    await testDb.db.$executeRawUnsafe(`
      CREATE TRIGGER reject_second_manual_delivery
      BEFORE INSERT ON "OnboardingMailDelivery"
      WHEN NEW.source = 'MANUAL' AND (SELECT COUNT(*) FROM "OnboardingMailDelivery" WHERE source = 'MANUAL') >= 1
      BEGIN
        SELECT RAISE(ABORT, 'row two unavailable');
      END
    `);
    const route = createOnboardingMailManualSendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const response = await route.POST(request("/api/admin/onboarding-mail/manual-send", "admin", "POST", {
      employeeIds: employees.map((employee) => employee.id), localDate: "2026-07-21", displayedRecipientCount: 2, confirmed: true,
    }));

    expect(response.status).toBe(400);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { source: OnboardingMailDeliverySource.MANUAL } })).toBe(0);
  });

  it("allows resend only for SENT, non-TEST deliveries", async () => {
    const { revision } = await seedPublishedTemplate();
    const route = createOnboardingMailResendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const unsafeCases = [
      { status: OnboardingMailDeliveryStatus.PENDING, source: OnboardingMailDeliverySource.MANUAL },
      { status: OnboardingMailDeliveryStatus.SENDING, source: OnboardingMailDeliverySource.MANUAL },
      { status: OnboardingMailDeliveryStatus.FAILED, source: OnboardingMailDeliverySource.MANUAL },
      { status: OnboardingMailDeliveryStatus.UNKNOWN, source: OnboardingMailDeliverySource.MANUAL },
      { status: OnboardingMailDeliveryStatus.CANCELLED, source: OnboardingMailDeliverySource.MANUAL },
      { status: OnboardingMailDeliveryStatus.SENT, source: OnboardingMailDeliverySource.TEST },
    ];
    for (const [index, item] of unsafeCases.entries()) {
      const employee = await seedEmployee(603 + index);
      const original = await createWelcomeDelivery({ source: item.source, recipientId: employee.id, templateRevisionId: revision.id, scheduledLocalDate: null, scheduledAt: now }, { db: testDb.db, now: () => now });
      await testDb.db.onboardingMailDelivery.update({ where: { id: original.id }, data: { status: item.status, sentAt: item.status === OnboardingMailDeliveryStatus.SENT ? now : null } });
      const response = await route.POST(request("/api/admin/onboarding-mail/resend", "admin", "POST", {
        deliveryIds: [original.id], localDate: "2026-07-22", displayedRecipientCount: 1, confirmed: true,
      }));
      expect(response.status, `unsafe resend case ${index}`).toBe(400);
      expect(await testDb.db.onboardingMailDelivery.count({ where: { resendOfId: original.id } })).toBe(0);
    }
  });

  it("creates exactly one linked resend when two valid requests race", async () => {
    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(604);
    const original = await createWelcomeDelivery({ source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id, templateRevisionId: revision.id, scheduledLocalDate: null, scheduledAt: now }, { db: testDb.db, now: () => now });
    await testDb.db.onboardingMailDelivery.update({ where: { id: original.id }, data: { status: OnboardingMailDeliveryStatus.SENT, sentAt: now } });
    const route = createOnboardingMailResendRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", bulkThreshold: 20 });
    const body = { deliveryIds: [original.id], localDate: "2026-07-22", displayedRecipientCount: 1, confirmed: true };

    const responses = await Promise.all([
      route.POST(request("/api/admin/onboarding-mail/resend", "admin", "POST", body)),
      route.POST(request("/api/admin/onboarding-mail/resend", "super", "POST", body)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await testDb.db.onboardingMailDelivery.count({ where: { resendOfId: original.id } })).toBe(1);
  });

  it("uploads role-labelled private assets and returns UNKNOWN as a conservative history filter", async () => {
    const assets = createOnboardingMailAssetsRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 });
    const form = new FormData();
    form.set("role", "INLINE_BACKGROUND");
    form.set("contentId", "welcome-background");
    form.set("file", new File([validPng()], "background.png", { type: "image/png" }));
    const uploadRequest = new Request("http://localhost:3000/api/admin/onboarding-mail/assets", {
      method: "POST",
      headers: { cookie: `cohort_harbor_session=${tokens.get("admin")}`, origin: "http://localhost:3000" },
      body: form,
    });
    const upload = await assets.POST(uploadRequest);
    expect(upload.status).toBe(201);
    const uploadedAsset = (await upload.json()).asset as { id: string };
    expect(uploadedAsset).toMatchObject({ originalName: "background.png", role: "INLINE_BACKGROUND", contentId: "welcome-background" });
    expect((await assets.GET(request("/api/admin/onboarding-mail/assets", "super"))).status).toBe(200);
    const assetPreview = createOnboardingMailAssetPreviewRoute({ db: testDb.db, privateRoot, maxBytes: 1024 * 1024 }, uploadedAsset.id);
    const previewResponse = await assetPreview.GET(request(`/api/admin/onboarding-mail/assets/${uploadedAsset.id}/preview`, "admin"));
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("content-type")).toBe("image/png");
    expect(previewResponse.headers.get("cache-control")).toContain("no-store");
    expect(previewResponse.headers.get("content-disposition")).not.toContain(privateRoot);
    expect(new Uint8Array(await previewResponse.arrayBuffer())).toEqual(validPng());
    expect((await assetPreview.GET(request(`/api/admin/onboarding-mail/assets/${uploadedAsset.id}/preview`, "employee"))).status).toBe(403);

    const { revision } = await seedPublishedTemplate();
    const employee = await seedEmployee(400);
    const unknown = await createWelcomeDelivery({ source: OnboardingMailDeliverySource.MANUAL, recipientId: employee.id, templateRevisionId: revision.id, scheduledLocalDate: null, scheduledAt: now }, { db: testDb.db, now: () => now });
    await testDb.db.onboardingMailDelivery.update({ where: { id: unknown.id }, data: { status: OnboardingMailDeliveryStatus.UNKNOWN } });
    const deliveries = createOnboardingMailDeliveriesRoute({ db: testDb.db });
    const payload = await (await deliveries.GET(request("/api/admin/onboarding-mail/deliveries?status=UNKNOWN", "admin"))).json();
    expect(payload.deliveries).toHaveLength(1);
    expect(payload.deliveries[0]).toMatchObject({ id: unknown.id, statusLabel: "发送调用结果未确认（可能已发出）" });
    expect(JSON.stringify(payload)).not.toContain("providerMessageId");
  });

  it("converts the configured attachment MiB limit and enforces the exact one-MiB boundary", async () => {
    const maxBytes = mailAttachmentMaxBytes(1);
    expect(maxBytes).toBe(1024 * 1024);
    const route = createOnboardingMailAssetsRoute({ db: testDb.db, privateRoot, maxBytes });
    const uploadText = async (size: number, name: string) => {
      const form = new FormData();
      form.set("role", "ATTACHMENT");
      form.set("file", new File(["a".repeat(size)], name, { type: "text/plain" }));
      return route.POST(new Request("http://localhost:3000/api/admin/onboarding-mail/assets", {
        method: "POST", headers: { cookie: `cohort_harbor_session=${tokens.get("admin")}`, origin: "http://localhost:3000" }, body: form,
      }));
    };

    expect((await uploadText(maxBytes, "exact.txt")).status).toBe(201);
    expect((await uploadText(maxBytes + 1, "oversize.txt")).status).toBe(400);
  });

  it("returns stable Chinese exclusion labels and a never-selected past-missed list", async () => {
    await seedPublishedTemplate();
    await testDb.db.systemSetting.create({ data: { id: "default", onboardingMailAutomationEnabled: true, onboardingMailAutomationEnabledAt: now } });
    await testDb.db.user.create({ data: {
      employeeNo: "NO-MAIL", name: "无邮箱员工", email: null, hiredAt: now, role: Role.EMPLOYEE, sourceType: UserSource.MANUAL, passwordHash: "unused",
    } });
    await testDb.db.user.create({ data: {
      employeeNo: "PAST-ADMIN", name: "历史管理员", email: "past-admin@example.invalid",
      hiredAt: new Date("2026-07-21T02:00:00.000Z"), role: Role.ADMIN,
      sourceType: UserSource.MANUAL, passwordHash: "unused",
    } });
    await seedEmployee(500, new Date("2026-07-21T02:00:00.000Z"));
    const route = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const payload = await (await route.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();
    expect(payload.today.employees).toEqual(expect.arrayContaining([expect.objectContaining({ employeeNo: "NO-MAIL", reason: "NO_EMAIL", reasonLabel: "缺少邮箱" })]));
    expect(payload.pastMissed).toEqual([expect.objectContaining({ employeeNo: "MAIL-E-500", localDate: "2026-07-21", reasonLabel: "历史未发送，可手动处理", selected: false })]);
  });

  it("filters delivered past hires before applying the past-missed result cap", async () => {
    const { revision } = await seedPublishedTemplate();
    await testDb.db.user.createMany({ data: [
      ...Array.from({ length: 105 }, (_, index) => ({
        employeeNo: `RECENT-DELIVERED-${index.toString().padStart(3, "0")}`,
        name: `近期已发 ${index}`,
        email: `recent-delivered-${index}@example.invalid`,
        hiredAt: new Date("2026-07-21T02:00:00.000Z"),
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: "unused",
      })),
      ...[1, 2].map((index) => ({
        employeeNo: `OLDER-MISSED-${index}`,
        name: `较早漏发 ${index}`,
        email: `older-missed-${index}@example.invalid`,
        hiredAt: new Date("2026-07-10T02:00:00.000Z"),
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: "unused",
      })),
    ] });
    const deliveredRecipients = await testDb.db.user.findMany({
      where: { employeeNo: { startsWith: "RECENT-DELIVERED-" } },
      select: { id: true, email: true },
    });
    await testDb.db.onboardingMailDelivery.createMany({ data: deliveredRecipients.map((recipient, index) => ({
      status: OnboardingMailDeliveryStatus.SENT,
      source: OnboardingMailDeliverySource.AUTOMATIC,
      idempotencyKey: `overview-delivered-${index}`,
      recipientId: recipient.id,
      recipientEmailSnapshot: recipient.email!,
      recipientSnapshot: {},
      templateRevisionId: revision.id,
      templateSnapshot: {},
      fieldSummary: {},
      ccSnapshot: [],
      attachmentSummary: [],
      scheduledLocalDate: "2026-07-21",
      scheduledAt: now,
      sentAt: now,
    })) });

    const route = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const payload = await (await route.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();

    expect(payload.pastMissed.map((item: { employeeNo: string }) => item.employeeNo)).toEqual(["OLDER-MISSED-1", "OLDER-MISSED-2"]);
    expect(payload.truncation.pastMissed).toEqual({ limit: 100, truncated: false });
  });

  it("bounds overview and delivery history with explicit truncation metadata", async () => {
    const { revision } = await seedPublishedTemplate();
    await testDb.db.user.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
      employeeNo: `PAST-${index.toString().padStart(3, "0")}`,
      name: `历史员工 ${index}`,
      email: `past-${index}@example.invalid`,
      hiredAt: new Date("2026-07-21T02:00:00.000Z"),
      role: Role.EMPLOYEE,
      sourceType: UserSource.MANUAL,
      passwordHash: "unused",
    })) });
    await testDb.db.onboardingMailDelivery.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
      status: OnboardingMailDeliveryStatus.PENDING,
      source: OnboardingMailDeliverySource.MANUAL,
      recipientEmailSnapshot: `history-${index}@example.invalid`,
      recipientSnapshot: {},
      templateRevisionId: revision.id,
      templateSnapshot: {},
      fieldSummary: {},
      ccSnapshot: [],
      attachmentSummary: [],
      scheduledAt: now,
    })) });

    const overviewRoute = createOnboardingMailOverviewRoute({ db: testDb.db, now: () => now, bulkConfirmationSecret: "route-test-secret", smtpConfigured: true });
    const overviewPayload = await (await overviewRoute.GET(request("/api/admin/onboarding-mail/overview", "admin"))).json();
    expect(overviewPayload.pastMissed).toHaveLength(100);
    expect(overviewPayload.truncation.pastMissed).toEqual({ limit: 100, truncated: true });

    const deliveriesRoute = createOnboardingMailDeliveriesRoute({ db: testDb.db });
    const deliveryPayload = await (await deliveriesRoute.GET(request("/api/admin/onboarding-mail/deliveries", "admin"))).json();
    expect(deliveryPayload.deliveries).toHaveLength(200);
    expect(deliveryPayload.truncation.deliveries).toEqual({ limit: 200, truncated: true });
  });
});
