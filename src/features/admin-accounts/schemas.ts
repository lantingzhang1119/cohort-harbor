import { z } from "zod";

import { newPasswordSchema } from "@/features/auth/password-policy";

export const adminIdentityInputSchema = z.object({
  employeeNo: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  temporaryPassword: newPasswordSchema,
  currentPassword: z.string().min(1),
});

export const createAdminInputSchema = z.object({
  employeeNo: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
});

export const destructiveConfirmationSchema = z.object({
  currentPassword: z.string().min(1),
  confirmation: z.literal("永久删除管理员"),
});

export type AdminIdentityInput = z.input<typeof adminIdentityInputSchema>;
export type CreateAdminInput = z.input<typeof createAdminInputSchema>;
export type DestructiveConfirmationInput = z.input<
  typeof destructiveConfirmationSchema
>;
