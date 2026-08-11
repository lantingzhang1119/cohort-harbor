import { z } from "zod";

export const materialInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000).nullable().optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
});

export type MaterialInput = z.input<typeof materialInputSchema>;
