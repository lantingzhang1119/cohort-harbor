import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import type { NotificationSender, ReminderRecipient } from "@/features/reminders/notification-sender";

export class SimulatedEmailSender implements NotificationSender {
  constructor(private readonly db: PrismaClient) {}

  async send(recipients: ReminderRecipient[], actorId: string) {
    const [actor, recipientUsers] = await Promise.all([
      this.db.user.findUniqueOrThrow({
        where: { id: actorId },
        select: { id: true, employeeNo: true, name: true, email: true, role: true },
      }),
      this.db.user.findMany({
        where: { id: { in: recipients.map((recipient) => recipient.userId) } },
        select: { id: true, employeeNo: true, name: true, email: true, role: true },
      }),
    ]);
    const recipientById = new Map(recipientUsers.map((recipient) => [recipient.id, recipient]));
    const result = await this.db.simulatedEmailLog.createMany({
      data: recipients.map((recipient) => {
        const recipientUser = recipientById.get(recipient.userId);
        if (!recipientUser) throw new Error("催办收件人不存在");
        return {
          recipientId: recipient.userId,
          recipientSnapshot: snapshotUserIdentity(recipientUser),
          actorId,
          actorSnapshot: snapshotUserIdentity(actor),
          templateKey: "ONBOARDING_TASK_REMINDER",
          status: "SIMULATED_NO_SMTP",
        };
      }),
    });
    return result.count;
  }
}
