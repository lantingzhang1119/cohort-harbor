export type ReminderRecipient = { userId: string };

export interface NotificationSender {
  send(recipients: ReminderRecipient[], actorId: string): Promise<number>;
}
