import { z } from "zod";

const safePortalHrefSchema = z.string().trim().min(1).max(2_048).superRefine((href, context) => {
  if (/[\u0000-\u001F\u007F\\]/u.test(href)) {
    context.addIssue({ code: "custom", message: "链接包含不安全字符" });
    return;
  }

  if (href.startsWith("/") && !href.startsWith("//")) return;

  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) {
      context.addIssue({ code: "custom", message: "外部链接必须使用无凭据的 HTTPS 地址" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "链接必须是站内路径或 HTTPS 地址" });
  }
});

export const safePortalActionSchema = z.object({
  href: safePortalHrefSchema,
  target: z.enum(["_self", "_blank"]),
}).strict();

export type SafePortalAction = z.infer<typeof safePortalActionSchema>;
