import { z } from "zod";

import { UserStatus, WorkLocation } from "@/generated/prisma/enums";

const optionalText = z.string().trim().max(120).optional().transform((value) => value || null);
const optionalDate = z.preprocess(
  (value) => value === "" ? null : value,
  z.coerce.date().optional().nullable(),
);

export const createEmployeeSchema = z.object({
  employeeNo: z.string().trim().min(1, "工号不能为空").max(50),
  name: z.string().trim().min(1, "姓名不能为空").max(80),
  email: z.string().trim().email("邮箱格式不正确").max(160),
  firstDepartment: optionalText,
  secondDepartment: optionalText,
  position: optionalText,
  workLocation: z.enum(WorkLocation),
  hiredAt: z.coerce.date(),
  leftAt: optionalDate,
});

export const updateEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email("邮箱格式不正确").max(160).optional(),
  firstDepartment: optionalText,
  secondDepartment: optionalText,
  position: optionalText,
  workLocation: z.enum(WorkLocation).optional(),
  status: z.enum(UserStatus).optional(),
  hiredAt: optionalDate,
  leftAt: optionalDate,
});

export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;
