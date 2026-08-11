import type { PasswordResetDelivery, PasswordResetRecipient, PasswordResetSender } from "@/features/auth/password-reset-sender";
import type { SmtpOutcome, SmtpMessage } from "@/features/mail/smtp-transport";
import { BRAND } from "@/lib/brand";

function resetUrl(baseUrl: string, token: string) {
  const url = new URL("/reset-password", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export class SmtpPasswordResetSender implements PasswordResetSender {
  readonly mode = "SMTP" as const;

  constructor(
    private readonly transport: { send(message: SmtpMessage): Promise<SmtpOutcome> },
    private readonly baseUrl: string,
  ) {}

  async send({
    recipient,
    token,
  }: {
    recipient: PasswordResetRecipient;
    token: string;
  }): Promise<PasswordResetDelivery> {
    if (!recipient.email) throw new Error("收件人没有可用邮箱");
    const url = resetUrl(this.baseUrl, token);
    const outcome = await this.transport.send({
      to: { email: recipient.email, displayName: recipient.name },
      senderDisplayName: `${BRAND.name}${BRAND.platformName}`,
      subject: `${BRAND.name}${BRAND.platformName}密码重置`,
      text: `请在 30 分钟内打开以下链接重置密码：\n${url}\n如非本人操作，请忽略此邮件。`,
      html: `<p>请在 30 分钟内重置密码。</p><p><a href="${url}">重置密码</a></p><p>如非本人操作，请忽略此邮件。</p>`,
      cc: [],
      attachments: [],
    });
    if (outcome.kind !== "accepted") throw new Error(`密码重置邮件发送失败：${outcome.failureCode}`);
    return {};
  }
}
