import "server-only";

import nodemailer from "nodemailer";

export type SmtpTransportConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  envelopeSender: string;
  hardTimeoutMs: number;
};

export type SmtpMailbox = { email: string; displayName?: string | null };

export type SmtpAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  contentId?: string;
};

export type SmtpMessage = {
  to: SmtpMailbox;
  senderDisplayName: string;
  subject: string;
  text: string;
  html: string;
  cc: SmtpMailbox[];
  attachments: SmtpAttachment[];
};

export type SmtpProtocolStage =
  | "PRE_DATA"
  | "DNS"
  | "CONNECT"
  | "GREETING"
  | "TLS"
  | "AUTH"
  | "ENVELOPE"
  | "DATA"
  | "POST_DATA";

export type SmtpOutcome =
  | {
    kind: "accepted";
    providerMessageId: string | null;
    responseSummary: string | null;
    protocolStage: "POST_DATA";
    ccRejectedCount: number;
  }
  | {
    kind: "definite-retryable" | "definite-terminal" | "ambiguous";
    failureCode: string;
    errorSummary: string;
    protocolStage: Exclude<SmtpProtocolStage, "POST_DATA">;
  };

export type NodemailerLikeTransport = {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
  close?(): void | Promise<void>;
};

type TransportFactory = (options: Record<string, unknown>) => NodemailerLikeTransport;

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`SMTP ${label} 未配置`);
  return trimmed;
}

function sanitizedText(raw: string, exactSecrets: string[]): string {
  const exactRedacted = [...new Set(exactSecrets.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .reduce((text, secret) => text.split(secret).join("[redacted]"), raw);
  return exactRedacted
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(pass(?:word)?|token|secret)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function errorMetadata(error: unknown): { responseCode?: number; command?: string; code?: string; response?: string } {
  if (!error || typeof error !== "object") return {};
  const item = error as Record<string, unknown>;
  return {
    responseCode: typeof item.responseCode === "number" ? item.responseCode : undefined,
    command: typeof item.command === "string" ? item.command : undefined,
    code: typeof item.code === "string" ? item.code : undefined,
    response: typeof item.response === "string" ? item.response : undefined,
  };
}

function errorStage(
  error: unknown,
  observedStage: Exclude<SmtpProtocolStage, "POST_DATA">,
): Exclude<SmtpProtocolStage, "POST_DATA"> {
  const metadata = errorMetadata(error);
  const command = metadata.command?.trim().toUpperCase() ?? "";
  const code = metadata.code?.trim().toUpperCase() ?? "";
  const message = error instanceof Error ? error.message : "";
  // Nodemailer reports an unexpected socket close as CONN even while it is
  // awaiting the final DATA response. Preserve positive DATA-stage evidence.
  if (observedStage === "DATA") return "DATA";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"].includes(code)) return "DNS";
  if (/greeting/i.test(message)) return "GREETING";
  if (command.startsWith("AUTH") || code === "EAUTH") return "AUTH";
  if (command === "STARTTLS" || code === "ETLS" || /CERT|TLS|SSL/.test(code) || /certificate|TLS|SSL/i.test(message)) return "TLS";
  if (command.startsWith("EHLO") || command.startsWith("HELO")) return "GREETING";
  if (command.startsWith("MAIL") || command.startsWith("RCPT") || code === "EENVELOPE") return "ENVELOPE";
  if (command === "DATA" || code === "EMESSAGE") return "DATA";
  if (command === "CONN" || ["ECONNECTION", "ESOCKET", "ECONNREFUSED", "ETIMEDOUT"].includes(code)) {
    return observedStage === "PRE_DATA" || observedStage === "CONNECT" ? "CONNECT" : observedStage;
  }
  return observedStage;
}

function classifyError(
  error: unknown,
  exactSecrets: string[],
  observedStage: Exclude<SmtpProtocolStage, "POST_DATA">,
): Exclude<SmtpOutcome, { kind: "accepted" }> {
  const metadata = errorMetadata(error);
  const protocolStage = errorStage(error, observedStage);
  const summary = sanitizedText(error instanceof Error ? error.message : "SMTP 传输失败", exactSecrets);
  if (metadata.responseCode && metadata.responseCode >= 400 && metadata.responseCode < 500) {
    return { kind: "definite-retryable", failureCode: `SMTP_${metadata.responseCode}`, errorSummary: summary, protocolStage };
  }
  if (metadata.responseCode && metadata.responseCode >= 500 && metadata.responseCode < 600) {
    return { kind: "definite-terminal", failureCode: `SMTP_${metadata.responseCode}`, errorSummary: summary, protocolStage };
  }
  const code = metadata.code?.replace(/[^A-Z0-9_-]/gi, "_").toUpperCase();
  if (code === "SMTP_HARD_TIMEOUT" && protocolStage !== "DATA") {
    return {
      kind: "ambiguous",
      failureCode: code,
      errorSummary: summary,
      protocolStage,
    };
  }
  if (protocolStage !== "DATA") {
    return {
      kind: "definite-retryable",
      failureCode: `SMTP_${code || "PRE_DATA"}`,
      errorSummary: summary,
      protocolStage,
    };
  }
  return {
    kind: "ambiguous",
    failureCode: "SMTP_AMBIGUOUS",
    errorSummary: summary,
    protocolStage,
  };
}

function mailboxAddress(value: unknown): string | null {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (!value || typeof value !== "object") return null;
  const address = (value as Record<string, unknown>).address;
  return typeof address === "string" ? address.trim().toLowerCase() : null;
}

function resultAddresses(result: Record<string, unknown>, field: "accepted" | "rejected"): string[] | null {
  if (!Array.isArray(result[field])) return null;
  return result[field].map(mailboxAddress).filter((entry): entry is string => Boolean(entry));
}

function primaryRejection(result: Record<string, unknown>, primary: string): unknown {
  if (!Array.isArray(result.rejectedErrors)) return null;
  return result.rejectedErrors.find((value) => {
    if (!value || typeof value !== "object") return false;
    return mailboxAddress((value as Record<string, unknown>).recipient) === primary;
  }) ?? null;
}

function createProtocolTracker() {
  let stage: Exclude<SmtpProtocolStage, "POST_DATA"> = "PRE_DATA";
  let awaitingDataReply = false;
  const observe = (data: unknown, message: unknown) => {
    if (!data || typeof data !== "object") return;
    const metadata = data as Record<string, unknown>;
    if (metadata.tnx === "network" && metadata.action === "connected") stage = "CONNECT";
    if (metadata.tnx === "message" && typeof metadata.outByteCount === "number") stage = "DATA";
    if (metadata.tnx === "client" && typeof message === "string") {
      const command = message.trim().toUpperCase();
      if (command.startsWith("EHLO") || command.startsWith("HELO")) stage = "GREETING";
      else if (command === "STARTTLS") stage = "TLS";
      else if (command.startsWith("AUTH")) stage = "AUTH";
      else if (command.startsWith("MAIL") || command.startsWith("RCPT")) stage = "ENVELOPE";
      else if (command === "DATA") awaitingDataReply = true;
    }
    if (metadata.tnx === "server" && awaitingDataReply && typeof message === "string") {
      awaitingDataReply = false;
      if (/^[23]\d{2}\b/.test(message.trim())) stage = "DATA";
    }
  };
  const logger = {
    trace: observe,
    debug: observe,
    info: observe,
    warn: observe,
    error: observe,
    fatal: observe,
  };
  return {
    logger,
    reset() { stage = "PRE_DATA"; awaitingDataReply = false; },
    current() { return stage; },
  };
}

function nodemailerStageTimeouts(hardTimeoutMs: number) {
  return {
    connectionTimeout: Math.floor(hardTimeoutMs / 4),
    greetingTimeout: Math.floor(hardTimeoutMs / 2),
    socketTimeout: Math.floor(hardTimeoutMs * 3 / 4),
  };
}

function envelopeSender(value: string): string {
  const address = required(value, "FROM");
  if (address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(address)) {
    throw new Error("SMTP FROM 无效");
  }
  return address;
}

export function createSmtpTransport(
  input: SmtpTransportConfig,
  dependencies: { createTransport?: TransportFactory } = {},
) {
  const config = {
    ...input,
    host: required(input.host, "HOST"),
    username: required(input.username, "USERNAME"),
    password: required(input.password, "PASSWORD"),
    envelopeSender: envelopeSender(input.envelopeSender),
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("SMTP PORT 无效");
  }
  if (!Number.isSafeInteger(config.hardTimeoutMs) || config.hardTimeoutMs < 4) {
    throw new Error("SMTP 硬超时无效");
  }
  const stageTimeouts = nodemailerStageTimeouts(config.hardTimeoutMs);
  const protocolTracker = createProtocolTracker();
  const createTransport: TransportFactory = dependencies.createTransport
    ?? ((options: Record<string, unknown>) => nodemailer.createTransport(options));
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    // This is a no-output stage observer. It never formats, stores, or emits
    // SMTP log text, and message bodies remain disabled by debug=false.
    logger: protocolTracker.logger,
    transactionLog: true,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    connectionTimeout: stageTimeouts.connectionTimeout,
    greetingTimeout: stageTimeouts.greetingTimeout,
    socketTimeout: stageTimeouts.socketTimeout,
  });
  let poisoned = false;
  let sendInFlight = false;
  let closePromise: Promise<void> | undefined;

  function closeTransport(): Promise<void> {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await transport.close?.();
        } catch {
          // Closing a pooled transport is best-effort cleanup. Send outcome
          // and worker disposition remain the authority for delivery state.
        }
      })();
    }
    return closePromise;
  }

  return {
    isUsable(): boolean {
      return !poisoned;
    },
    async send(message: SmtpMessage): Promise<SmtpOutcome> {
      if (poisoned) {
        return {
          kind: "definite-retryable",
          failureCode: "SMTP_TRANSPORT_POISONED",
          errorSummary: "SMTP transport unavailable after hard timeout",
          protocolStage: "PRE_DATA",
        };
      }
      if (sendInFlight) {
        return {
          kind: "definite-retryable",
          failureCode: "SMTP_TRANSPORT_BUSY",
          errorSummary: "SMTP transport already has a send in progress",
          protocolStage: "PRE_DATA",
        };
      }
      sendInFlight = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      protocolTracker.reset();
      const exactSecrets = [config.username, config.password];
      try {
        const envelopeRecipients = [message.to.email, ...message.cc.map((entry) => entry.email)];
        const send = transport.sendMail({
          from: { name: message.senderDisplayName, address: config.envelopeSender },
          envelope: { from: config.envelopeSender, to: envelopeRecipients },
          to: { name: message.to.displayName ?? "", address: message.to.email },
          cc: message.cc.map((entry) => ({ name: entry.displayName ?? "", address: entry.email })),
          subject: message.subject,
          text: message.text,
          html: message.html,
          textEncoding: "B",
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.fileName,
            contentType: attachment.mimeType,
            content: Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes),
            ...(attachment.contentId ? { cid: attachment.contentId } : {}),
          })),
        });
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("SMTP 传输硬超时"), {
            code: "SMTP_HARD_TIMEOUT",
            command: "HARD TIMEOUT",
          })), config.hardTimeoutMs);
        });
        const result = await Promise.race([send, timeout]) as Record<string, unknown>;
        const primary = message.to.email.trim().toLowerCase();
        const accepted = resultAddresses(result, "accepted");
        const rejected = resultAddresses(result, "rejected");
        if (accepted && !accepted.includes(primary)) {
          const rejection = primaryRejection(result, primary);
          if (rejection) return classifyError(rejection, exactSecrets, "ENVELOPE");
          return {
            kind: "definite-terminal",
            failureCode: "SMTP_PRIMARY_REJECTED",
            errorSummary: "SMTP primary recipient rejected",
            protocolStage: "ENVELOPE",
          };
        }
        if (rejected?.includes(primary)) {
          const rejection = primaryRejection(result, primary);
          if (rejection) return classifyError(rejection, exactSecrets, "ENVELOPE");
          return {
            kind: "definite-terminal",
            failureCode: "SMTP_PRIMARY_REJECTED",
            errorSummary: "SMTP primary recipient rejected",
            protocolStage: "ENVELOPE",
          };
        }
        const ccAddresses = new Set(message.cc.map((entry) => entry.email.trim().toLowerCase()));
        const ccRejectedCount = rejected?.filter((address) => ccAddresses.has(address)).length ?? 0;
        const response = typeof result.response === "string" ? sanitizedText(result.response, exactSecrets) : null;
        return {
          kind: "accepted",
          providerMessageId: typeof result.messageId === "string" ? result.messageId : null,
          responseSummary: ccRejectedCount > 0
            ? `${response ? `${response}; ` : ""}ccRejected=${ccRejectedCount}`
            : response,
          protocolStage: "POST_DATA",
          ccRejectedCount,
        };
      } catch (error) {
        const outcome = classifyError(error, exactSecrets, protocolTracker.current());
        if (errorMetadata(error).code === "SMTP_HARD_TIMEOUT" || outcome.kind === "ambiguous") {
          poisoned = true;
          // Closing a poisoned pool must begin immediately, but a slow or
          // broken close must not extend the already-expired send deadline.
          void closeTransport();
        }
        return outcome;
      } finally {
        if (timer) clearTimeout(timer);
        sendInFlight = false;
      }
    },
    close(): Promise<void> {
      return closeTransport();
    },
  };
}
