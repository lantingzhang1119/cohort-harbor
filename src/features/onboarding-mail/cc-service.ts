import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { UserStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db/client";
import { z } from "zod";

export type CcEntry =
  | { kind: "USER"; userId: string; displayName?: string | null; sortOrder: number }
  | { kind: "EMAIL"; email: string; displayName?: string | null; sortOrder: number };

type WithoutSort<T> = T extends unknown ? Omit<T, "sortOrder"> : never;
export type CcInput = WithoutSort<CcEntry>;

export type Mailbox = { email: string; displayName?: string | null };

export type ResolvedCc = {
  email: string;
  displayName: string | null;
  source: "ACCOUNT" | "FIXED";
  userId?: string;
};

const MAX_CC_DISPLAY_NAME_LENGTH = 120;

function boundedCcDisplayName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .slice(0, MAX_CC_DISPLAY_NAME_LENGTH)
    .replace(/[\uD800-\uDBFF]$/u, "");
}

export type CcCandidate = {
  userId: string;
  employeeNo: string;
  name: string;
  email: string | null;
  label: string;
};

export class CcResolutionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_EMAIL"
      | "AMBIGUOUS_NAME"
      | "NAME_NOT_FOUND"
      | "ACCOUNT_NOT_AVAILABLE"
      | "ACCOUNT_EMAIL_MISSING",
    message: string,
    public readonly candidates?: CcCandidate[],
  ) {
    super(message);
    this.name = "CcResolutionError";
  }
}

const emailSchema = z.string().trim().max(254).email();

function canonicalEmail(value: string): string | null {
  const parsed = emailSchema.safeParse(value.normalize("NFKC").trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function candidate(user: { id: string; employeeNo: string; name: string; email: string | null }): CcCandidate {
  const name = user.name.trim();
  return {
    userId: user.id,
    employeeNo: user.employeeNo,
    name,
    email: user.email,
    label: `${name}（${user.employeeNo} · ${user.email ?? "未设置邮箱"}）`,
  };
}

async function availableUsers(db: PrismaClient) {
  return db.user.findMany({
    where: { status: UserStatus.ACTIVE, enabled: true },
    select: { id: true, employeeNo: true, name: true, email: true },
    orderBy: { employeeNo: "asc" },
  });
}

export async function searchCcCandidates(
  query: string,
  options: { db?: PrismaClient } = {},
): Promise<CcCandidate[]> {
  const normalized = normalizeIdentity(query);
  if (!normalized) return [];
  const users = await availableUsers(options.db ?? prisma);
  return users
    .filter((user) => [user.name, user.employeeNo, user.email ?? ""]
      .some((value) => normalizeIdentity(value).includes(normalized)))
    .map(candidate);
}

export async function resolveCcInput(
  input: string,
  options: { db?: PrismaClient } = {},
): Promise<CcInput> {
  const db = options.db ?? prisma;
  const trimmed = input.normalize("NFKC").trim();
  if (trimmed.includes("@")) {
    const normalizedEmail = canonicalEmail(trimmed);
    if (!normalizedEmail) throw new CcResolutionError("INVALID_EMAIL", "邮箱地址格式无效");
    const users = await availableUsers(db);
    const internal = users.find((user) => user.email && canonicalEmail(user.email) === normalizedEmail);
    if (internal) return { kind: "USER", userId: internal.id, displayName: internal.name.trim() };
    return { kind: "EMAIL", email: normalizedEmail, displayName: undefined };
  }

  const normalizedName = normalizeIdentity(trimmed);
  const matches = (await availableUsers(db))
    .filter((user) => normalizeIdentity(user.name) === normalizedName)
    .map(candidate);
  if (matches.length === 0) throw new CcResolutionError("NAME_NOT_FOUND", "没有找到匹配账号");
  if (matches.length > 1) throw new CcResolutionError("AMBIGUOUS_NAME", "姓名重复，请选择明确身份", matches);
  return { kind: "USER", userId: matches[0].userId, displayName: matches[0].name };
}

export async function resolveCcRecipients(
  entries: CcEntry[],
  recipient: Mailbox,
  options: { db?: PrismaClient } = {},
): Promise<ResolvedCc[]> {
  const db = options.db ?? prisma;
  const recipientEmail = canonicalEmail(recipient.email);
  if (!recipientEmail) throw new CcResolutionError("INVALID_EMAIL", "收件人邮箱地址格式无效");
  const excluded = recipientEmail;
  const seen = new Set<string>();
  const resolved: ResolvedCc[] = [];
  const sorted = entries.map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sortOrder - right.entry.sortOrder || left.index - right.index);

  for (const { entry } of sorted) {
    let item: ResolvedCc;
    if (entry.kind === "EMAIL") {
      const parsed = canonicalEmail(entry.email);
      if (!parsed) throw new CcResolutionError("INVALID_EMAIL", "固定抄送邮箱格式无效");
      item = {
        email: parsed,
        displayName: boundedCcDisplayName(entry.displayName),
        source: "FIXED",
      };
    } else {
      const account = await db.user.findUnique({
        where: { id: entry.userId },
        select: { id: true, name: true, email: true, enabled: true, status: true },
      });
      if (!account || !account.enabled || account.status !== UserStatus.ACTIVE) {
        throw new CcResolutionError("ACCOUNT_NOT_AVAILABLE", "抄送账号当前不可用");
      }
      const accountEmail = account.email ? canonicalEmail(account.email) : null;
      if (!accountEmail) {
        throw new CcResolutionError("ACCOUNT_EMAIL_MISSING", "抄送账号当前没有有效邮箱");
      }
      item = {
        email: accountEmail,
        displayName: boundedCcDisplayName(entry.displayName) ?? boundedCcDisplayName(account.name),
        source: "ACCOUNT",
        userId: account.id,
      };
    }
    const normalized = item.email;
    if (normalized === excluded || seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(item);
  }
  return resolved;
}
