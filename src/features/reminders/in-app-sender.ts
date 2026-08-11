import type { PrismaClient } from "@/generated/prisma/client";
import { NotificationType } from "@/generated/prisma/enums";
import type { NotificationSender, ReminderRecipient } from "@/features/reminders/notification-sender";

export class InAppSender implements NotificationSender {
  constructor(private readonly db: PrismaClient) {}

  async send(recipients: ReminderRecipient[], actorId: string) {
    void actorId;
    const result = await this.db.notification.createMany({
      data: recipients.map((recipient) => ({
        userId: recipient.userId,
        type: NotificationType.REMINDER,
        title: "入职学习考试待完成提醒",
        body: "你的入职学习或考试任务尚未完成，请登录平台查看截止日期。",
      })),
    });
    return result.count;
  }
}
