import type { PrismaClient, User } from "@/generated/prisma/client";
import { SimulatedPasswordResetSender } from "@/features/auth/simulated-password-reset-sender";
import { SmtpPasswordResetSender } from "@/features/auth/smtp-password-reset-sender";
import { createSmtpTransport, type NodemailerLikeTransport } from "@/features/mail/smtp-transport";

export const DEVELOPMENT_SIMULATION_LABEL = "开发模拟邮件（非真实发送）";

export type PasswordResetRecipient = Pick<
  User,
  "id" | "employeeNo" | "name" | "email" | "role"
>;

export type DevelopmentPreview = {
  label: typeof DEVELOPMENT_SIMULATION_LABEL;
  url: string;
};

export type PasswordResetDelivery = {
  developmentPreview?: DevelopmentPreview;
};

export interface PasswordResetSender {
  readonly mode: "SMTP" | "DEVELOPMENT_SIMULATION" | "UNAVAILABLE";
  send(input: {
    recipient: PasswordResetRecipient;
    token: string;
  }): Promise<PasswordResetDelivery>;
  createUnusableDevelopmentPreview?(token: string): DevelopmentPreview;
}

export type PasswordResetSenderEnv = {
  NODE_ENV?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  APP_BASE_URL?: string;
};

export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: Record<
    "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    (data: unknown, message: unknown) => void
  >;
  transactionLog: true;
  debug: false;
  disableFileAccess: true;
  disableUrlAccess: true;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
};

class UnavailablePasswordResetSender implements PasswordResetSender {
  readonly mode = "UNAVAILABLE" as const;

  async send(): Promise<PasswordResetDelivery> {
    throw new Error("密码重置邮件发送器未配置");
  }
}

function completeSmtpConfiguration(env: PasswordResetSenderEnv) {
  const values = [
    env.SMTP_HOST,
    env.SMTP_PORT,
    env.SMTP_SECURE,
    env.SMTP_USERNAME,
    env.SMTP_PASSWORD,
    env.SMTP_FROM,
    env.APP_BASE_URL,
  ];
  if (values.some((value) => !value?.trim())) return null;
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (env.SMTP_SECURE !== "true" && env.SMTP_SECURE !== "false") return null;
  return {
    host: env.SMTP_HOST!,
    port,
    secure: env.SMTP_SECURE === "true",
    username: env.SMTP_USERNAME!,
    password: env.SMTP_PASSWORD!,
    from: env.SMTP_FROM!,
    baseUrl: env.APP_BASE_URL!,
  };
}

function hasAnySmtpConfiguration(env: PasswordResetSenderEnv) {
  return [
    env.SMTP_HOST,
    env.SMTP_USERNAME,
    env.SMTP_PASSWORD,
    env.SMTP_FROM,
  ].some((value) => Boolean(value?.trim()));
}

export function createPasswordResetSender({
  db,
  env,
  createTransport,
}: {
  db: PrismaClient;
  env: PasswordResetSenderEnv;
  createTransport?: (options: SmtpTransportOptions) => NodemailerLikeTransport;
}): PasswordResetSender {
  const smtp = completeSmtpConfiguration(env);
  if (smtp) {
    const transport = createSmtpTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      password: smtp.password,
      envelopeSender: smtp.from,
      hardTimeoutMs: 120_000,
    }, createTransport ? { createTransport: createTransport as (options: Record<string, unknown>) => NodemailerLikeTransport } : {});
    return new SmtpPasswordResetSender(transport, smtp.baseUrl);
  }
  if (
    env.NODE_ENV === "development" &&
    !hasAnySmtpConfiguration(env)
  ) {
    return new SimulatedPasswordResetSender(
      db,
      env.APP_BASE_URL?.trim() || "http://localhost:3000",
    );
  }
  return new UnavailablePasswordResetSender();
}
