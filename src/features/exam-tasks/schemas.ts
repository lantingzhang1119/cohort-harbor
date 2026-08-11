import { z } from "zod";

import { WorkLocation } from "@/generated/prisma/enums";

export const employeeFilterSchema = z.object({
  query: z.string().trim().optional(),
  department: z.string().trim().optional(),
  location: z.enum(WorkLocation).optional(),
  enabled: z.boolean().optional(),
});

export const explicitSelectionSchema = z.object({
  mode: z.literal("EXPLICIT"),
  userIds: z.array(z.string().min(1)).min(1, "请至少选择一名员工"),
});

export const filterSelectionSchema = z.object({
  mode: z.literal("FILTER"),
  filter: employeeFilterSchema.default({}),
  excludedUserIds: z.array(z.string().min(1)).default([]),
});

export const assigneeSelectionSchema = z.discriminatedUnion("mode", [
  explicitSelectionSchema,
  filterSelectionSchema,
]);

export const publishExamTaskSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8, "幂等键无效").max(128),
    name: z.string().trim().min(1, "考试名称不能为空").max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    questionBankId: z.string().min(1, "请选择题库"),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    passingScore: z.number().int().min(1).max(100).default(80),
    selection: assigneeSelectionSchema,
  })
  .superRefine((value, context) => {
    if (!(value.startsAt instanceof Date) || Number.isNaN(value.startsAt.getTime())) {
      context.addIssue({
        code: "custom",
        path: ["startsAt"],
        message: "开始时间无效",
      });
    }
    if (!(value.endsAt instanceof Date) || Number.isNaN(value.endsAt.getTime())) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "结束时间无效",
      });
    }
    if (
      value.startsAt instanceof Date &&
      value.endsAt instanceof Date &&
      !Number.isNaN(value.startsAt.getTime()) &&
      !Number.isNaN(value.endsAt.getTime()) &&
      value.startsAt.getTime() >= value.endsAt.getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "开始时间必须早于结束时间",
      });
    }
  });

export type EmployeeFilterInput = z.infer<typeof employeeFilterSchema>;
export type AssigneeSelectionInput = z.infer<typeof assigneeSelectionSchema>;
export type PublishExamTaskInput = z.infer<typeof publishExamTaskSchema>;
