import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssignmentStatus, Role, UserSource, WorkLocation } from "@/generated/prisma/enums";
import {
  exportReminderCsv,
  listReminderTargets,
  sendReminder,
} from "@/features/reminders/reminder-service";
import { hashPassword } from "@/features/auth/password";
import { createTestDatabase } from "../helpers/test-db";

describe("reminder service", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let actorId: string;
  let recipientId: string;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    const passwordHash = await hashPassword("InitialPass!23");
    actorId = (await testDb.db.user.create({ data: { employeeNo: "ADMIN-REMINDER", name: "催办管理员", role: Role.ADMIN, sourceType: UserSource.MANUAL, passwordHash } })).id;
    recipientId = (await testDb.db.user.create({ data: { employeeNo: "TEST-REMINDER", name: "催办员工", email: "reminder@example.invalid", firstDepartment: "研发中心", workLocation: WorkLocation.SHANGHAI, sourceType: UserSource.MANUAL, passwordHash } })).id;
    const exam = await testDb.db.exam.create({ data: { name: "催办测试" } });
    await testDb.db.examAssignment.create({ data: { userId: recipientId, examId: exam.id, status: AssignmentStatus.NOT_STARTED, dueAt: new Date("2026-07-20T00:00:00.000Z") } });
  });
  afterEach(async () => testDb.cleanup());

  it("filters targets across assignment status, department and location", async () => {
    const targets = await listReminderTargets(testDb.db, { statuses: [AssignmentStatus.NOT_STARTED], department: "研发中心", location: WorkLocation.SHANGHAI });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ userId: recipientId, status: AssignmentStatus.NOT_STARTED });
  });

  it("sends in-app and simulated-email reminders without SMTP", async () => {
    const result = await sendReminder(testDb.db, { recipientIds: [recipientId], actorId, channels: ["IN_APP", "SIMULATED_EMAIL"] });
    expect(result).toEqual({ inAppCount: 1, simulatedEmailCount: 1 });
    expect(await testDb.db.notification.count()).toBe(1);
    expect((await testDb.db.simulatedEmailLog.findFirstOrThrow()).status).toBe("SIMULATED_NO_SMTP");
  });

  it("exports a UTF-8 BOM CSV without password fields", async () => {
    const targets = await listReminderTargets(testDb.db, {});
    const csv = exportReminderCsv(targets);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("工号,姓名,部门,工作地点,任务状态,截止日期,邮箱");
    expect(csv).not.toContain("password");
    expect(csv).not.toContain("密码");
  });
});
