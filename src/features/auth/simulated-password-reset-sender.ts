import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import {
  DEVELOPMENT_SIMULATION_LABEL,
  type DevelopmentPreview,
  type PasswordResetDelivery,
  type PasswordResetRecipient,
  type PasswordResetSender,
} from "@/features/auth/password-reset-sender";

export class SimulatedPasswordResetSender implements PasswordResetSender {
  readonly mode = "DEVELOPMENT_SIMULATION" as const;

  constructor(
    private readonly db: PrismaClient,
    private readonly baseUrl: string,
  ) {}

  private preview(token: string): DevelopmentPreview {
    const url = new URL("/reset-password", this.baseUrl);
    url.searchParams.set("token", token);
    return { label: DEVELOPMENT_SIMULATION_LABEL, url: url.toString() };
  }

  createUnusableDevelopmentPreview(token: string) {
    return this.preview(token);
  }

  async send({
    recipient,
    token,
  }: {
    recipient: PasswordResetRecipient;
    token: string;
  }): Promise<PasswordResetDelivery> {
    await this.db.simulatedEmailLog.create({
      data: {
        recipientId: recipient.id,
        recipientSnapshot: snapshotUserIdentity(recipient),
        actorId: null,
        actorSnapshot: undefined,
        templateKey: "PASSWORD_RESET",
        status: "DEVELOPMENT_SIMULATED",
      },
    });
    return { developmentPreview: this.preview(token) };
  }
}
