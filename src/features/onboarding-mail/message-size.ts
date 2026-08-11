import "server-only";

import { randomBytes } from "node:crypto";

export const DEFAULT_RAW_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export const DEFAULT_ENCODED_MIME_LIMIT = 25 * 1024 * 1024;
// Nodemailer RFC 2047/2231-encodes transport-managed headers that this
// streaming model deliberately does not reproduce. The published-template
// schema bounds both CC entries and attachments to 100 and display names to
// 120/240 characters. One MiB keeps more than twice the measured expansion at
// those pinned maxima, leaving headroom for safe Nodemailer patch upgrades.
export const TRANSPORT_HEADER_ALLOWANCE_BYTES = 1024 * 1024;

export type MimeBinaryPart = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  contentId?: string;
};

export type MimeMessageInput = {
  from: string;
  to: string[];
  cc?: Array<string | { email: string; displayName?: string | null }>;
  subject: string;
  html: string;
  text: string;
  attachments: MimeBinaryPart[];
  inlineResources: MimeBinaryPart[];
};

export type MailSizeLimits = {
  rawAttachmentMaxBytes?: number;
  encodedMimeMaxBytes?: number;
};

export type MimeSerializationOptions = {
  maxBoundaryAttempts?: number;
  boundaryTokenFactory?: () => string;
};

export class MailMessageSizeError extends Error {
  constructor(
    public readonly code: "RAW_ATTACHMENTS_TOO_LARGE" | "ENCODED_MIME_TOO_LARGE" | "INVALID_HEADER" | "MIME_BOUNDARY_COLLISION",
    message: string,
    public readonly measuredBytes?: number,
    public readonly limitBytes?: number,
  ) {
    super(message);
    this.name = "MailMessageSizeError";
  }
}

export function encodedBase64SizeWithWrapping(rawBytes: number): number {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new RangeError("rawBytes 必须是非负安全整数");
  if (rawBytes === 0) return 0;
  const encoded = 4 * Math.ceil(rawBytes / 3);
  return encoded + 2 * Math.ceil(encoded / 76);
}

function safeHeader(value: string): string {
  if (/\r|\n/.test(value)) throw new MailMessageSizeError("INVALID_HEADER", "邮件头包含换行符");
  return value;
}

function quoted(value: string): string {
  return safeHeader(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function mailboxHeader(value: string | { email: string; displayName?: string | null }): string {
  if (typeof value === "string") return safeHeader(value);
  const email = safeHeader(value.email);
  const displayName = value.displayName?.trim();
  return displayName ? `"${quoted(displayName)}" <${email}>` : email;
}

function wrappedBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  if (!encoded) return "";
  return `${encoded.match(/.{1,76}/g)!.join("\r\n")}\r\n`;
}

function randomBoundaryToken(): string {
  return randomBytes(24).toString("hex");
}

function nonCollidingBoundary(
  label: "mixed" | "related" | "alternative",
  input: MimeMessageInput,
  options: MimeSerializationOptions,
  reserved: string[] = [],
): string {
  const controlledBodies = `${input.text}\n${input.html}`;
  const maxAttempts = options.maxBoundaryAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16) {
    throw new RangeError("maxBoundaryAttempts 必须是 1–16 的安全整数");
  }
  const tokenFactory = options.boundaryTokenFactory ?? randomBoundaryToken;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = tokenFactory();
    if (!/^[a-f0-9]{48}$/.test(token)) continue;
    const boundary = `=_cohort-harbor_${label}_${token}`;
    if (!controlledBodies.includes(boundary) && !reserved.includes(boundary)) return boundary;
  }
  throw new MailMessageSizeError("MIME_BOUNDARY_COLLISION", "无法生成与正文无碰撞的 MIME boundary");
}

type MimeChunk = string | { binaryBytes: Uint8Array };

function binaryPartChunks(boundary: string, part: MimeBinaryPart, inline: boolean): MimeChunk[] {
  return [
    `--${boundary}\r\n`,
    `Content-Type: ${safeHeader(part.mimeType)}; name="${quoted(part.fileName)}"\r\n`,
    "Content-Transfer-Encoding: base64\r\n",
    `Content-Disposition: ${inline ? "inline" : "attachment"}; filename="${quoted(part.fileName)}"\r\n`,
    ...(inline ? [`Content-ID: <${safeHeader(part.contentId!)}>\r\n`] : []),
    "\r\n",
    { binaryBytes: part.bytes },
  ];
}

function textPartChunks(boundary: string, mimeType: "text/plain" | "text/html", body: string): MimeChunk[] {
  return [
    `--${boundary}\r\nContent-Type: ${mimeType}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
    { binaryBytes: Buffer.from(body, "utf8") },
  ];
}

function mimeChunks(input: MimeMessageInput, options: MimeSerializationOptions = {}): MimeChunk[] {
  const mixed = nonCollidingBoundary("mixed", input, options);
  const related = nonCollidingBoundary("related", input, options, [mixed]);
  const alternative = nonCollidingBoundary("alternative", input, options, [mixed, related]);
  const chunks: MimeChunk[] = [
    `From: ${safeHeader(input.from)}\r\n`,
    `To: ${input.to.map(safeHeader).join(", ")}\r\n`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(mailboxHeader).join(", ")}\r\n`] : []),
    `Subject: ${safeHeader(input.subject)}\r\n`,
    "MIME-Version: 1.0\r\n",
    `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n`,
    `--${mixed}\r\nContent-Type: multipart/related; boundary="${related}"\r\n\r\n`,
    `--${related}\r\nContent-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n`,
    ...textPartChunks(alternative, "text/plain", input.text),
    ...textPartChunks(alternative, "text/html", input.html),
    `--${alternative}--\r\n`,
  ];
  for (const part of input.inlineResources) chunks.push(...binaryPartChunks(related, part, true));
  chunks.push(`--${related}--\r\n`);
  for (const part of input.attachments) chunks.push(...binaryPartChunks(mixed, part, false));
  chunks.push(`--${mixed}--\r\n`);
  return chunks;
}

export function estimateMimeMessageSize(input: MimeMessageInput, options: MimeSerializationOptions = {}): number {
  return mimeChunks(input, options).reduce(
    (total, chunk) => total + (typeof chunk === "string"
      ? Buffer.byteLength(chunk)
      : encodedBase64SizeWithWrapping(chunk.binaryBytes.byteLength)),
    0,
  );
}

export async function writeMimeMessageToSink(
  input: MimeMessageInput,
  sink: { write(chunk: string | Uint8Array): void | Promise<void> },
  options: MimeSerializationOptions = {},
): Promise<void> {
  for (const chunk of mimeChunks(input, options)) {
    await sink.write(typeof chunk === "string" ? chunk : wrappedBase64(chunk.binaryBytes));
  }
}

export function assertMailMessageSize(input: MimeMessageInput, limits: MailSizeLimits = {}): void {
  const rawLimit = limits.rawAttachmentMaxBytes ?? DEFAULT_RAW_ATTACHMENT_LIMIT;
  const mimeLimit = limits.encodedMimeMaxBytes ?? DEFAULT_ENCODED_MIME_LIMIT;
  const rawBytes = [...input.attachments, ...input.inlineResources]
    .reduce((total, part) => total + part.bytes.byteLength, 0);
  if (rawBytes > rawLimit) {
    throw new MailMessageSizeError("RAW_ATTACHMENTS_TOO_LARGE", "附件原始总大小超过限制", rawBytes, rawLimit);
  }
  const encodedBytes = estimateMimeMessageSize(input) + TRANSPORT_HEADER_ALLOWANCE_BYTES;
  if (encodedBytes > mimeLimit) {
    throw new MailMessageSizeError("ENCODED_MIME_TOO_LARGE", "完整编码邮件大小超过限制", encodedBytes, mimeLimit);
  }
}

export async function guardMessageBeforeDispatch(
  input: MimeMessageInput,
  markDispatched: () => void | Promise<void>,
  limits: MailSizeLimits = {},
): Promise<void> {
  assertMailMessageSize(input, limits);
  await markDispatched();
}
