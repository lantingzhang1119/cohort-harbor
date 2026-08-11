import { describe, expect, it, vi } from "vitest";

import { createSmtpTransport } from "@/features/mail/smtp-transport";

describe("SMTP attachment Buffer reuse", () => {
  it("passes a cached readFile Buffer to nodemailer without allocating a second copy", async () => {
    const sendMail = vi.fn(async (message: Record<string, unknown>) => {
      void message;
      return {
        accepted: ["new.hire@example.invalid"],
        rejected: [],
        response: "250 queued",
        messageId: "buffer-reuse",
      };
    });
    const transport = createSmtpTransport({
      host: "smtp.example.invalid",
      port: 587,
      secure: false,
      username: "mailer",
      password: "secret",
      envelopeSender: "hr@example.invalid",
      hardTimeoutMs: 1_000,
    }, { createTransport: () => ({ sendMail }) });
    const bytes = Buffer.from("cached attachment", "utf8");

    await transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "HR",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [{ fileName: "guide.txt", mimeType: "text/plain", bytes }],
    });

    const attachment = (sendMail.mock.calls[0]![0].attachments as Array<{ content: Buffer }>)[0];
    expect(attachment.content).toBe(bytes);
  });
});
