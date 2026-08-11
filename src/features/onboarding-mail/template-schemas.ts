import { z } from "zod";

const transportText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\r\n]/.test(value), "邮件传输字段不能包含换行符");

export const mailFieldConfigSchema = z.object({
  key: z.string().trim().min(1).max(80),
  kind: z.enum(["BUILTIN", "CONSTANT"]),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  sortOrder: z.number().int().safe(),
  required: z.boolean(),
  dateFormat: z.string().trim().min(1).max(40).nullish(),
  constantValue: z.string().max(2_000)
    .refine((value) => !/[\r\n]/.test(value), "常量值不能包含换行符")
    .nullish(),
}).strict();

const attachmentBase = {
  displayName: z.string().trim().min(1).max(240),
  sortOrder: z.number().int().safe(),
};

export const templateAttachmentSchema = z.discriminatedUnion("role", [
  z.object({
    ...attachmentBase,
    role: z.literal("ATTACHMENT"),
    fileAssetId: z.string().min(1).optional(),
    materialVersionId: z.string().min(1).optional(),
    contentId: z.never().optional(),
  }).strict().refine((value) => Boolean(value.fileAssetId) !== Boolean(value.materialVersionId), {
    message: "附件必须且只能引用一个固定来源",
  }),
  z.object({
    ...attachmentBase,
    role: z.enum(["INLINE_LOGO", "INLINE_BACKGROUND", "INLINE_BODY"]),
    fileAssetId: z.string().min(1),
    materialVersionId: z.never().optional(),
    contentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,126}$/),
  }).strict(),
]);

export const templateCcEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("USER"),
    userId: z.string().min(1),
    email: z.never().optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    sortOrder: z.number().int().safe(),
  }).strict(),
  z.object({
    kind: z.literal("EMAIL"),
    userId: z.never().optional(),
    email: z.string().trim().email().transform((value) => value.toLowerCase()),
    displayName: z.string().trim().min(1).max(120).optional(),
    sortOrder: z.number().int().safe(),
  }).strict(),
]);

export const templateDraftSchema = z.object({
  templateId: z.string().min(1),
  senderDisplayName: transportText(120),
  subject: transportText(500),
  htmlBody: z.string().min(1).max(1_000_000),
  textBody: z.string().max(1_000_000).nullish(),
  fieldConfig: z.array(mailFieldConfigSchema).max(100),
  styleConfig: z.record(z.string(), z.unknown()),
  attachments: z.array(templateAttachmentSchema).max(100),
  ccEntries: z.array(templateCcEntrySchema).max(100),
}).strict();

export type TemplateDraft = z.infer<typeof templateDraftSchema>;
export type TemplateAttachment = z.infer<typeof templateAttachmentSchema>;
export type TemplateCcEntry = z.infer<typeof templateCcEntrySchema>;
