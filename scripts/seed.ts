import "dotenv/config";

import { fileURLToPath } from "node:url";
import path from "node:path";

import type { PrismaClient } from "../src/generated/prisma/client";
import {
  City,
  EmployeeModuleKey,
  OnboardingMailFieldKind,
  QuestionBankQuestionType,
  QuestionBankSource,
  QuestionBankStatus,
  QuestionType,
  Role,
  UserSource,
  UserStatus,
} from "../src/generated/prisma/enums";
import { hashPassword } from "../src/features/auth/password";
import { mockExam } from "../prisma/seed.example";

export type SeedOptions = {
  adminUsername: string;
  adminDisplayName: string;
  adminPassword?: string;
  resetAdminPassword?: boolean;
};

function validPassword(password: string | undefined): password is string {
  return (
    typeof password === "string" &&
    password.length >= 10 &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password)
  );
}

const passwordRequirement = "至少 10 位且必须同时包含英文字母和数字";
const invalidSuperAdminState = "数据库中必须恰好存在一个可用的超级管理员";

async function ensureSeededQuestionBank(
  db: PrismaClient,
  exam: Awaited<ReturnType<PrismaClient["exam"]["upsert"]>>,
  admin: Awaited<ReturnType<typeof ensureAdmin>>,
) {
  const existing = await db.questionBank.findUnique({ where: { legacyExamId: exam.id } });
  if (existing) return existing;

  const legacyQuestions = await db.question.findMany({
    where: { examId: exam.id },
    orderBy: { sequence: "asc" },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  const actorSnapshot = {
    id: admin.id,
    employeeNo: admin.employeeNo,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    source: "seed",
  };

  return db.$transaction(async (transaction) => {
    const concurrent = await transaction.questionBank.findUnique({
      where: { legacyExamId: exam.id },
    });
    if (concurrent) return concurrent;
    const hasDefault = await transaction.questionBank.count({
      where: { isDefault: true, deletedAt: null },
    });
    const bank = await transaction.questionBank.create({
      data: {
        id: `legacy-bank-${exam.id}`,
        name: exam.name,
        description: "由基础数据初始化",
        isDefault: hasDefault === 0,
        status: exam.enabled ? QuestionBankStatus.ENABLED : QuestionBankStatus.DISABLED,
        source: QuestionBankSource.LEGACY,
        legacyExamId: exam.id,
        versionNumber: 1,
        passingScore: exam.passingScore,
        durationMinutes: exam.durationMinutes,
        randomizeQuestions: exam.randomizeQuestions,
        randomizeOptions: exam.randomizeOptions,
        showWrongAnswers: exam.showWrongAnswers,
        enabledScore: legacyQuestions
          .filter((question) => question.enabled)
          .reduce((total, question) => total + question.score, 0),
        questionCount: legacyQuestions.length,
        createdById: admin.id,
        createdBySnapshot: actorSnapshot,
        updatedById: admin.id,
        updatedBySnapshot: actorSnapshot,
      },
    });
    for (const legacyQuestion of legacyQuestions) {
      const question = await transaction.questionBankQuestion.create({
        data: {
          id: `legacy-bank-question-${legacyQuestion.id}`,
          questionBankId: bank.id,
          sequence: legacyQuestion.sequence,
          type: legacyQuestion.type === QuestionType.MULTIPLE
            ? QuestionBankQuestionType.MULTIPLE_CHOICE
            : QuestionBankQuestionType.SINGLE_CHOICE,
          prompt: legacyQuestion.prompt,
          score: legacyQuestion.score,
          enabled: legacyQuestion.enabled,
        },
      });
      if (legacyQuestion.options.length) {
        await transaction.questionBankOption.createMany({
          data: legacyQuestion.options.map((option) => ({
            id: `legacy-bank-option-${option.id}`,
            questionId: question.id,
            label: option.optionKey,
            text: option.text,
            isCorrect: option.isCorrect,
            sortOrder: option.sortOrder,
          })),
        });
      }
    }
    return bank;
  });
}

export async function ensureAdmin(db: PrismaClient, options: SeedOptions) {
  if (!options.adminUsername.trim()) throw new Error("ADMIN_USERNAME 不能为空");
  const superAdmins = await db.user.findMany({
    where: { role: Role.SUPER_ADMIN },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
  });
  if (superAdmins.length > 1) throw new Error(invalidSuperAdminState);
  const superAdmin = superAdmins[0];
  if (superAdmin) {
    if (
      !superAdmin.enabled ||
      superAdmin.status !== UserStatus.ACTIVE ||
      superAdmin.adminArchivedAt
    ) {
      throw new Error(invalidSuperAdminState);
    }
    if (
      superAdmin.employeeNo === options.adminUsername &&
      options.resetAdminPassword
    ) {
      if (!validPassword(options.adminPassword)) {
        throw new Error(`重置管理员密码时，ADMIN_PASSWORD ${passwordRequirement}`);
      }
      return db.user.update({
        where: { id: superAdmin.id },
        data: { passwordHash: await hashPassword(options.adminPassword) },
      });
    }
    return superAdmin;
  }
  const existing = await db.user.findUnique({ where: { employeeNo: options.adminUsername } });
  if (existing && existing.role !== Role.ADMIN) {
    throw new Error("ADMIN_USERNAME 已被普通员工账号占用，请更换管理员账号");
  }
  if (!existing && !validPassword(options.adminPassword)) {
    throw new Error(`首次初始化请在 .env 中设置 ADMIN_PASSWORD（${passwordRequirement}）`);
  }
  if (options.resetAdminPassword && !validPassword(options.adminPassword)) {
    throw new Error(`重置管理员密码时，ADMIN_PASSWORD ${passwordRequirement}`);
  }

  const passwordHash = !existing || options.resetAdminPassword
    ? await hashPassword(options.adminPassword!)
    : undefined;
  if (existing) {
    return db.user.update({
      where: { id: existing.id },
      data: {
        role: Role.SUPER_ADMIN,
        enabled: true,
        status: UserStatus.ACTIVE,
        mustChangePassword: false,
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
  }
  return db.user.create({
    data: {
      employeeNo: options.adminUsername,
      name: options.adminDisplayName,
      role: Role.SUPER_ADMIN,
      sourceType: UserSource.MANUAL,
      enabled: true,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      passwordHash: passwordHash!,
    },
  });
}

export async function seedDatabase(db: PrismaClient, options: SeedOptions) {
  const admin = await ensureAdmin(db, options);
  await db.systemSetting.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  for (const key of Object.values(EmployeeModuleKey)) {
    await db.employeeModuleSetting.upsert({
      where: { key },
      create: { key, enabled: true },
      update: {},
    });
  }
  const builtInMailFields = [
    { key: "name", label: "姓名", sortOrder: 10, required: true },
    { key: "employeeNo", label: "工号", sortOrder: 20, required: true },
    { key: "email", label: "邮箱", sortOrder: 30, required: true },
    { key: "hiredAt", label: "入职日期", sortOrder: 40, required: true, dateFormat: "yyyy-MM-dd" },
    { key: "firstDepartment", label: "一级部门", sortOrder: 50, required: false },
    { key: "secondDepartment", label: "二级部门", sortOrder: 60, required: false },
    { key: "position", label: "岗位", sortOrder: 70, required: false },
    { key: "workLocation", label: "工作地点", sortOrder: 80, required: false },
    { key: "currentDate", label: "当前日期", sortOrder: 90, required: false, dateFormat: "yyyy-MM-dd" },
    { key: "companyName", label: "公司名称", sortOrder: 100, required: true },
  ];
  for (const field of builtInMailFields) {
    await db.onboardingMailField.upsert({
      where: { key: field.key },
      create: {
        ...field,
        kind: OnboardingMailFieldKind.BUILTIN,
        builtIn: true,
        enabled: true,
      },
      update: {},
    });
  }
  const exam = await db.exam.upsert({
    where: { name: mockExam.name },
    create: {
      name: mockExam.name,
      passingScore: mockExam.passingScore,
      durationMinutes: mockExam.durationMinutes,
      dueDaysAfterHire: mockExam.dueDaysAfterHire,
      enabled: true,
    },
    update: { enabled: true },
  });

  for (const item of mockExam.questions) {
    const question = await db.question.upsert({
      where: { examId_sequence: { examId: exam.id, sequence: item.sequence } },
      create: { examId: exam.id, sequence: item.sequence, type: item.type, prompt: item.prompt, score: item.score, enabled: true },
      update: { type: item.type, prompt: item.prompt, score: item.score },
    });
    await db.questionOption.deleteMany({
      where: { questionId: question.id, optionKey: { notIn: item.options.map((option) => option.key) } },
    });
    for (const option of item.options) {
      await db.questionOption.upsert({
        where: { questionId_optionKey: { questionId: question.id, optionKey: option.key } },
        create: { questionId: question.id, optionKey: option.key, text: option.text, isCorrect: item.correctKeys.includes(option.key), sortOrder: item.options.indexOf(option) },
        update: { text: option.text, isCorrect: item.correctKeys.includes(option.key), sortOrder: item.options.indexOf(option) },
      });
    }
  }
  await ensureSeededQuestionBank(db, exam, admin);

  const guides = [
    { city: City.SHANGHAI, title: "上海入职指南" },
    { city: City.SHENZHEN, title: "深圳入职指南" },
    { city: City.CHANGSHA, title: "长沙入职指南" },
    { city: City.XIAN, title: "西安入职指南" },
  ];
  for (const guide of guides) {
    await db.cityGuide.upsert({
      where: { city: guide.city },
      create: { ...guide, summary: "办公、交通、住宿与本地生活入职指引", enabled: true },
      update: { title: guide.title, enabled: true },
    });
  }

  return { adminId: admin.id, examId: exam.id, questionCount: mockExam.questions.length, guideCount: guides.length };
}

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const { prisma } = await import("../src/lib/db/client");
  try {
    const result = await seedDatabase(prisma, {
      adminUsername: process.env.ADMIN_USERNAME ?? "admin",
      adminDisplayName: process.env.ADMIN_DISPLAY_NAME ?? "系统管理员",
      adminPassword: process.env.ADMIN_PASSWORD,
      resetAdminPassword: process.argv.includes("--reset-admin-password"),
    });
    console.log(`基础数据已就绪：${result.questionCount} 道题、${result.guideCount} 个城市指南。`);
  } finally {
    await prisma.$disconnect();
  }
}

if (isMainModule()) {
  void main()
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : "种子初始化失败"); process.exitCode = 1; })
}
