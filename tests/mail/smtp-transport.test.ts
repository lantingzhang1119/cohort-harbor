import { createServer, type Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  createSmtpTransport,
  type NodemailerLikeTransport,
} from "@/features/mail/smtp-transport";

const config = {
  host: "127.0.0.1",
  port: 2525,
  secure: false,
  username: "mailer",
  password: "smtp-secret",
  envelopeSender: "bounce@example.invalid",
  // Worker runtime config's minimum production hard deadline is five seconds.
  hardTimeoutMs: 5_000,
};

async function scriptedSmtp(mode: "success" | "rcpt-451" | "rcpt-550" | "post-data-disconnect" | "post-data-timeout") {
  const sockets = new Set<Socket>();
  let dataCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost test smtp\r\n");
    let buffer = "";
    let readingData = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        if (readingData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          dataCount += 1;
          buffer = buffer.slice(end + 5);
          readingData = false;
          if (mode === "post-data-disconnect") {
            socket.destroy();
            return;
          }
          if (mode === "post-data-timeout") return;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^(?:EHLO|HELO)/i.test(line)) socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 PIPELINING\r\n");
        else if (/^AUTH/i.test(line)) socket.write("235 2.7.0 authenticated\r\n");
        else if (/^MAIL FROM/i.test(line)) socket.write("250 2.1.0 sender ok\r\n");
        else if (/^RCPT TO/i.test(line)) socket.write(mode === "rcpt-451"
          ? "451 4.3.0 retry later\r\n"
          : mode === "rcpt-550" ? "550 5.1.1 no such user\r\n" : "250 2.1.5 recipient ok\r\n");
        else if (/^DATA/i.test(line)) { readingData = true; socket.write("354 end with dot\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local SMTP did not bind TCP");
  return {
    port: address.port,
    dataCount: () => dataCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SMTP transport", () => {
  it("rejects an invalid or overlong envelope sender before creating Nodemailer", () => {
    const createTransport = vi.fn();

    for (const envelopeSender of ["not-an-email", `${"a".repeat(250)}@example.invalid`]) {
      expect(() => createSmtpTransport({ ...config, envelopeSender }, { createTransport }))
        .toThrow("SMTP FROM 无效");
    }
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("locks down Nodemailer and uses the configured envelope sender while allowing only a display-name override", async () => {
    const sendMail = vi.fn(async () => ({
      accepted: ["new.hire@example.invalid"],
      rejected: [],
      messageId: "message-1",
      response: "250 queued for new.hire@example.invalid mailer password=smtp-secret",
    }));
    const createTransport = vi.fn(() => ({ sendMail }) satisfies NodemailerLikeTransport);
    const transport = createSmtpTransport(config, { createTransport });

    const outcome = await transport.send({
      to: { email: "new.hire@example.invalid", displayName: "新员工" },
      senderDisplayName: "新人学习平台",
      subject: "欢迎加入",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [{ email: "mentor@example.invalid", displayName: "导师" }],
      attachments: [{ fileName: "guide.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2]) }],
    });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 2525,
      secure: false,
      auth: { user: "mailer", pass: "smtp-secret" },
      logger: expect.objectContaining({
        trace: expect.any(Function),
        debug: expect.any(Function),
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
        fatal: expect.any(Function),
      }),
      transactionLog: true,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 1_250,
      greetingTimeout: 2_500,
      socketTimeout: 3_750,
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "新人学习平台", address: "bounce@example.invalid" },
      envelope: {
        from: "bounce@example.invalid",
        to: ["new.hire@example.invalid", "mentor@example.invalid"],
      },
      to: { name: "新员工", address: "new.hire@example.invalid" },
      cc: [{ name: "导师", address: "mentor@example.invalid" }],
      textEncoding: "B",
      attachments: [{
        filename: "guide.pdf",
        contentType: "application/pdf",
        content: Buffer.from([1, 2]),
      }],
    }));
    expect(JSON.stringify(sendMail.mock.calls[0])).not.toContain("smtp-secret");
    expect(outcome).toEqual({
      kind: "accepted",
      providerMessageId: "message-1",
      responseSummary: "250 queued for [redacted-email] [redacted] password=[redacted]",
      protocolStage: "POST_DATA",
      ccRejectedCount: 0,
    });
  });

  it("exposes an idempotent close that closes the pooled Nodemailer transport once", async () => {
    const close = vi.fn();
    const transport = createSmtpTransport(config, {
      createTransport: () => ({ sendMail: vi.fn(), close }),
    });

    await Promise.all([transport.close(), transport.close()]);
    await transport.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(transport.isUsable()).toBe(true);
  });

  it.each([
    ["synchronous throw", vi.fn(() => { throw new Error("sync close failed"); })],
    ["asynchronous rejection", vi.fn(async () => { throw new Error("async close failed"); })],
  ])("swallows an idempotent %s from pooled transport close", async (_label, close) => {
    const transport = createSmtpTransport(config, {
      createTransport: () => ({ sendMail: vi.fn(), close }),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(transport.close()).resolves.toBeUndefined();
      await expect(transport.close()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it.each([
    [451, "definite-retryable"],
    [550, "definite-terminal"],
  ] as const)("classifies explicit SMTP %s rejections", async (responseCode, kind) => {
    const transport = createSmtpTransport(config, {
      createTransport: () => ({
        sendMail: vi.fn(async () => {
          throw Object.assign(new Error(`${responseCode} rejected secret@example.invalid`), {
            responseCode,
            command: "RCPT TO",
            response: `${responseCode} rejected secret@example.invalid`,
          });
        }),
      }),
    });

    await expect(transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [],
    })).resolves.toMatchObject({ kind, failureCode: `SMTP_${responseCode}` });
  });

  it("classifies the outer hard timeout as ambiguous even without DATA-stage evidence", async () => {
    const transport = createSmtpTransport({ ...config, hardTimeoutMs: 10 }, {
      createTransport: () => ({
        sendMail: vi.fn(() => new Promise(() => undefined)),
      }),
    });

    const outcome = await transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [],
    });

    expect(outcome).toMatchObject({
      kind: "ambiguous",
      failureCode: "SMTP_HARD_TIMEOUT",
      protocolStage: "PRE_DATA",
    });
    expect(JSON.stringify(outcome)).not.toContain("new.hire@example.invalid");
  });

  it("poisons and closes the pooled transport after a hard timeout so later sends fail safely without re-entering Nodemailer", async () => {
    const sendMail = vi.fn(() => new Promise<never>(() => undefined));
    const close = vi.fn();
    const transport = createSmtpTransport({ ...config, hardTimeoutMs: 20 }, {
      createTransport: () => ({ sendMail, close }),
    });
    const message = {
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [],
    };

    expect(transport.isUsable()).toBe(true);

    await expect(transport.send(message)).resolves.toMatchObject({
      kind: "ambiguous",
      failureCode: "SMTP_HARD_TIMEOUT",
    });
    expect(transport.isUsable()).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    const second = await Promise.race([
      transport.send(message),
      new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 5)),
    ]);
    expect(second).toMatchObject({
      kind: "definite-retryable",
      failureCode: "SMTP_TRANSPORT_POISONED",
      protocolStage: "PRE_DATA",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects an overlapping send before Nodemailer can reset the shared protocol tracker", async () => {
    const sendMail = vi.fn(() => new Promise<never>(() => undefined));
    const close = vi.fn();
    const transport = createSmtpTransport({ ...config, hardTimeoutMs: 20 }, {
      createTransport: () => ({ sendMail, close }),
    });
    const message = {
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [],
    };

    const first = transport.send(message);
    await expect(transport.send(message)).resolves.toMatchObject({
      kind: "definite-retryable",
      failureCode: "SMTP_TRANSPORT_BUSY",
      protocolStage: "PRE_DATA",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);

    await expect(first).resolves.toMatchObject({
      kind: "ambiguous",
      failureCode: "SMTP_HARD_TIMEOUT",
    });
    await expect(transport.send(message)).resolves.toMatchObject({
      kind: "definite-retryable",
      failureCode: "SMTP_TRANSPORT_POISONED",
      protocolStage: "PRE_DATA",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps an abandoned DATA-stage timeout from contaminating the classification of a later send", async () => {
    const smtp = await scriptedSmtp("post-data-timeout");
    try {
      const transport = createSmtpTransport({ ...config, port: smtp.port, hardTimeoutMs: 500 });
      const message = {
        to: { email: "new.hire@example.invalid" },
        senderDisplayName: "学习平台",
        subject: "欢迎",
        text: "欢迎",
        html: "<p>欢迎</p>",
        cc: [],
        attachments: [],
      };

      await expect(transport.send(message)).resolves.toMatchObject({
        kind: "ambiguous",
        failureCode: "SMTP_AMBIGUOUS",
        protocolStage: "DATA",
      });
      expect(transport.isUsable()).toBe(false);
      await expect(transport.send(message)).resolves.toMatchObject({
        kind: "definite-retryable",
        failureCode: "SMTP_TRANSPORT_POISONED",
        protocolStage: "PRE_DATA",
      });
      expect(smtp.dataCount()).toBe(1);
    } finally {
      await smtp.close();
    }
  });

  it("lets an injected transport report DATA-stage evidence through the no-output protocol tracker", async () => {
    const transport = createSmtpTransport(config, {
      createTransport: (options) => {
        const logger = options.logger as { info(data: unknown, message: unknown): void };
        expect(options).toMatchObject({
          transactionLog: true,
          debug: false,
        });
        return {
          sendMail: vi.fn(async () => {
            logger.info({ tnx: "client" }, "DATA");
            logger.info({ tnx: "server" }, "354 continue");
            throw Object.assign(new Error("connection closed"), {
              command: "CONN",
              code: "ECONNECTION",
            });
          }),
        };
      },
    });

    await expect(transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎",
      text: "欢迎",
      html: "<p>欢迎</p>",
      cc: [],
      attachments: [],
    })).resolves.toMatchObject({
      kind: "ambiguous",
      protocolStage: "DATA",
    });
  });

  it("does not treat a resolved Nodemailer result as SENT when the primary recipient was rejected", async () => {
    const transport = createSmtpTransport(config, {
      createTransport: () => ({
        sendMail: vi.fn(async () => ({
          accepted: ["mentor@example.invalid"],
          rejected: ["new.hire@example.invalid"],
          rejectedErrors: [{ recipient: "new.hire@example.invalid", responseCode: 550, response: "550 no such user" }],
          response: "250 partial",
        })),
      }),
    });
    await expect(transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎", text: "欢迎", html: "<p>欢迎</p>",
      cc: [{ email: "mentor@example.invalid" }], attachments: [],
    })).resolves.toMatchObject({
      kind: "definite-terminal", failureCode: "SMTP_550", protocolStage: "ENVELOPE",
    });
  });

  it("reports employee delivery as accepted when only CC is rejected and records the partial CC count", async () => {
    const transport = createSmtpTransport(config, {
      createTransport: () => ({
        sendMail: vi.fn(async () => ({
          accepted: ["new.hire@example.invalid"],
          rejected: ["mentor@example.invalid"],
          rejectedErrors: [{ recipient: "mentor@example.invalid", responseCode: 550, response: "550 no such user" }],
          messageId: "partial-cc",
          response: "250 primary queued",
        })),
      }),
    });
    await expect(transport.send({
      to: { email: "new.hire@example.invalid" },
      senderDisplayName: "学习平台",
      subject: "欢迎", text: "欢迎", html: "<p>欢迎</p>",
      cc: [{ email: "mentor@example.invalid" }], attachments: [],
    })).resolves.toMatchObject({
      kind: "accepted",
      providerMessageId: "partial-cc",
      ccRejectedCount: 1,
      protocolStage: "POST_DATA",
      responseSummary: expect.stringContaining("ccRejected=1"),
    });
  });

  it.each([
    ["CONN", "ENOTFOUND", "definite-retryable", "DNS", "getaddrinfo ENOTFOUND"],
    ["CONN", "ETIMEDOUT", "definite-retryable", "CONNECT", "network failure"],
    ["EHLO", "ETIMEDOUT", "definite-retryable", "GREETING", "network failure"],
    ["STARTTLS", "ETLS", "definite-retryable", "TLS", "network failure"],
    ["AUTH PLAIN", "EAUTH", "definite-retryable", "AUTH", "network failure"],
    ["RCPT TO", "ECONNECTION", "definite-retryable", "ENVELOPE", "network failure"],
    ["DATA", "ECONNECTION", "ambiguous", "DATA", "network failure"],
  ] as const)("classifies %s failures using protocol stage", async (command, code, kind, protocolStage, errorMessage) => {
    const transport = createSmtpTransport(config, {
      createTransport: () => ({ sendMail: vi.fn(async () => {
        throw Object.assign(new Error(errorMessage), { command, code });
      }) }),
    });
    await expect(transport.send({
      to: { email: "new.hire@example.invalid" }, senderDisplayName: "学习平台",
      subject: "欢迎", text: "欢迎", html: "<p>欢迎</p>", cc: [], attachments: [],
    })).resolves.toMatchObject({ kind, protocolStage });
  });

  it("redacts exact configured username and password even when they occur as bare values", async () => {
    const credentials = { username: "opaque-user-123", password: "pa$$word[456]" };
    const transport = createSmtpTransport({ ...config, ...credentials }, {
      createTransport: () => ({ sendMail: vi.fn(async () => {
        throw Object.assign(new Error(`authentication failed ${credentials.username} ${credentials.password}`), {
          command: "AUTH PLAIN", code: "EAUTH",
        });
      }) }),
    });
    const outcome = await transport.send({
      to: { email: "new.hire@example.invalid" }, senderDisplayName: "学习平台",
      subject: "欢迎", text: "欢迎", html: "<p>欢迎</p>", cc: [], attachments: [],
    });
    expect(outcome).toMatchObject({ kind: "definite-retryable", protocolStage: "AUTH" });
    expect(JSON.stringify(outcome)).not.toContain(credentials.username);
    expect(JSON.stringify(outcome)).not.toContain(credentials.password);
  });

  it("throws when production SMTP configuration is incomplete", () => {
    expect(() => createSmtpTransport({ ...config, password: "" })).toThrow("SMTP");
  });

  it.each([
    ["success", "accepted"],
    ["rcpt-451", "definite-retryable"],
    ["rcpt-550", "definite-terminal"],
    ["post-data-disconnect", "ambiguous"],
    ["post-data-timeout", "ambiguous"],
  ] as const)("maps scripted local SMTP scenario %s without real mail", async (scenario, expectedKind) => {
    const smtp = await scriptedSmtp(scenario);
    try {
      const transport = createSmtpTransport({
        ...config,
        port: smtp.port,
        hardTimeoutMs: scenario === "post-data-timeout" ? 500 : 1_000,
      });
      const outcome = await transport.send({
        to: { email: "new.hire@example.invalid" },
        senderDisplayName: "学习平台",
        subject: "欢迎",
        text: "欢迎",
        html: "<p>欢迎</p>",
        cc: [],
        attachments: [],
      });
      expect(outcome.kind).toBe(expectedKind);
      if (scenario === "post-data-disconnect" || scenario === "post-data-timeout") {
        expect(outcome).toMatchObject({ protocolStage: "DATA" });
      }
      expect(smtp.dataCount()).toBe(
        scenario === "success" || scenario === "post-data-disconnect" || scenario === "post-data-timeout" ? 1 : 0,
      );
    } finally {
      await smtp.close();
    }
  });
});
