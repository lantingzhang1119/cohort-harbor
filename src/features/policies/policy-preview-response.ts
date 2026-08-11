import "server-only";

import { stat } from "node:fs/promises";

import type { PrismaClient } from "@/generated/prisma/client";
import { PolicyPreviewStatus, PolicyStatus } from "@/generated/prisma/enums";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";
import { defaultPrivateRoot, resolvePrivateAssetPathSecure } from "@/lib/storage/private-storage";

export async function findReadyPolicyPreview(
  db: PrismaClient,
  policyId: string,
  options: { publishedOnly: boolean },
) {
  return db.policy.findFirst({
    where: {
      id: policyId,
      deletedAt: null,
      ...(options.publishedOnly ? { status: PolicyStatus.PUBLISHED } : {}),
    },
    include: {
      versions: {
        where: { deletedAt: null, previewStatus: PolicyPreviewStatus.READY },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { previewAsset: true },
      },
    },
  });
}

export async function createPolicyPreviewResponse(
  request: Request,
  version: {
    id: string;
    previewFormat: string | null;
    previewAsset: { storageKey: string; mimeType: string; originalName: string } | null;
  },
  privateRoot = defaultPrivateRoot,
) {
  if (!version.previewAsset) return new Response("Not found", { status: 404 });
  const filePath = await resolvePrivateAssetPathSecure(version.previewAsset.storageKey, privateRoot);
  if (!filePath) return new Response("Not found", { status: 404 });
  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) return new Response("Not found", { status: 404 });
  const range = request.headers.get("range");
  let start = 0;
  let end = fileStats.size - 1;
  let statusCode = 200;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response("Invalid range", { status: 416 });
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= fileStats.size) return new Response("Invalid range", { status: 416 });
    statusCode = 206;
  }
  return createPrivateFileResponse(filePath, {
    contentType: version.previewAsset.mimeType,
    status: statusCode,
    start,
    end,
    headers: {
      "accept-ranges": "bytes",
      ...(statusCode === 206 ? { "content-range": `bytes ${start}-${end}/${fileStats.size}` } : {}),
      "content-disposition": `inline; filename="policy-preview-${version.id}"`,
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
