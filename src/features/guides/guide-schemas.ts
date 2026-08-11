import { z } from "zod";

export const updateGuideSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean(),
});

export type UpdateGuideInput = z.input<typeof updateGuideSchema>;

const optionalChapterText = z.string().trim().max(2000).nullable().optional().transform((value) => value || null);

export const guideChapterSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: optionalChapterText,
  address: z.string().trim().max(300).nullable().optional().transform((value) => value || null),
  contact: z.string().trim().max(200).nullable().optional().transform((value) => value || null),
  externalUrl: z.union([z.literal(""), z.url()]).nullable().optional().transform((value) => value || null),
  sortOrder: z.coerce.number().int().min(0).max(1000),
  enabled: z.boolean(),
});

export type GuideChapterInput = z.input<typeof guideChapterSchema>;
