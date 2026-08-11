import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role, UserSource } from "@/generated/prisma/enums";
import { hashPassword } from "@/features/auth/password";
import { findEnabledExamAssignment } from "@/features/exams/assignment-service";
import { createTestDatabase } from "../helpers/test-db";

describe("exam assignment eligibility", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    testDb = await createTestDatabase();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it("ignores obsolete assignments whose exam has been disabled", async () => {
    const user = await testDb.db.user.create({
      data: {
        employeeNo: "EXAM-ELIGIBILITY-001",
        name: "考试资格员工",
        role: Role.ADMIN,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("CurrentPass123"),
      },
    });
    const disabledExam = await testDb.db.exam.create({
      data: { name: "已停用考试", enabled: false },
    });
    await testDb.db.examAssignment.create({
      data: {
        userId: user.id,
        examId: disabledExam.id,
        dueAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    await expect(findEnabledExamAssignment(testDb.db, user.id)).resolves.toBeNull();
  });

  it("returns an assignment only when its linked exam is enabled", async () => {
    const user = await testDb.db.user.create({
      data: {
        employeeNo: "EXAM-ELIGIBILITY-002",
        name: "有效考试员工",
        role: Role.EMPLOYEE,
        sourceType: UserSource.MANUAL,
        passwordHash: await hashPassword("CurrentPass123"),
      },
    });
    const exam = await testDb.db.exam.create({ data: { name: "有效考试", enabled: true } });
    const assignment = await testDb.db.examAssignment.create({
      data: {
        userId: user.id,
        examId: exam.id,
        dueAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    await expect(findEnabledExamAssignment(testDb.db, user.id)).resolves.toMatchObject({
      id: assignment.id,
      examId: exam.id,
    });
  });
});
