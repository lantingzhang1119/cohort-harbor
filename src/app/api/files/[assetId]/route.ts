import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  FileAssetKind,
  SessionViewMode,
} from "@/generated/prisma/enums";
import { requireAdminAccess, requireSession } from "@/features/auth/guards";
import { authErrorResponse, readSessionToken } from "@/features/auth/route-utils";
import {
  employeeModuleForAsset,
  isKindServedByGenericFileRoute,
  requireEmployeeModule,
} from "@/features/employee-modules/module-guards";
import { prisma } from "@/lib/db/client";
import { createPrivateFileResponse } from "@/lib/storage/private-file-response";
import {
  defaultPrivateRoot,
  resolvePrivateAssetPathSecure,
} from "@/lib/storage/private-storage";

type Asset = Awaited<ReturnType<PrismaClient["fileAsset"]["findUnique"]>> & {};

async function isCurrentPublishedPortalAsset(db: PrismaClient, assetId: string) {
  const matches = await db.$queryRaw<Array<{ authorized: number }>>(Prisma.sql`
    SELECT 1 AS "authorized"
    FROM "GuidePortalAssetReference" AS asset_reference
    INNER JOIN "GuidePortalPublication" AS publication
      ON publication."id" = asset_reference."publicationId"
    INNER JOIN "CityGuide" AS guide
      ON guide."city" = publication."city"
      AND guide."enabled" = 1
    WHERE asset_reference."assetId" = ${assetId}
      AND publication."version" = (
        SELECT MAX(candidate."version")
        FROM "GuidePortalPublication" AS candidate
        WHERE candidate."city" = publication."city"
          AND candidate."viewport" = publication."viewport"
      )
    LIMIT 1
  `);
  return matches.length === 1;
}

async function authorizeEmployeeAsset(
  db: PrismaClient,
  asset: NonNullable<Asset>,
) {
  if (asset.kind === FileAssetKind.GUIDE_IMAGE || asset.kind === FileAssetKind.GUIDE_MAP) {
    return Boolean(await db.guideChapter.findFirst({
      where: {
        imageAssetId: asset.id,
        enabled: true,
        guide: { enabled: true },
      },
      select: { id: true },
    }));
  }
  if (asset.kind === FileAssetKind.PORTAL_IMAGE) {
    return isCurrentPublishedPortalAsset(db, asset.id);
  }
  return false;
}

async function authorizeAdminAsset(db: PrismaClient, asset: NonNullable<Asset>) {
  if (asset.kind === FileAssetKind.GUIDE_IMAGE || asset.kind === FileAssetKind.GUIDE_MAP) {
    return Boolean(await db.guideChapter.findFirst({
      where: { imageAssetId: asset.id },
      select: { id: true },
    }));
  }
  // Portal images are intentionally previewable immediately after an administrator uploads
  // them, before the draft receives its first reference. Other asset kinds remain deny-by-default.
  return asset.kind === FileAssetKind.PORTAL_IMAGE;
}

export function createPrivateFileRoute(
  dependencies: { db: PrismaClient; privateRoot?: string },
  assetId: string,
) {
  return async function GET(request: Request) {
    try {
      const session = await requireSession(dependencies.db, readSessionToken(request));
      const asset = await dependencies.db.fileAsset.findUnique({ where: { id: assetId } });
      if (!asset || !isKindServedByGenericFileRoute(asset.kind)) {
        return new Response("Not found", { status: 404 });
      }

      let authorized = false;
      if (session.viewMode === SessionViewMode.ADMIN) {
        requireAdminAccess(session);
        authorized = await authorizeAdminAsset(dependencies.db, asset);
      } else {
        const moduleKey = employeeModuleForAsset(asset.kind);
        if (!moduleKey) return new Response("Not found", { status: 404 });
        await requireEmployeeModule(session, moduleKey, dependencies.db);
        authorized = await authorizeEmployeeAsset(dependencies.db, asset);
      }
      if (!authorized) return new Response("Not found", { status: 404 });

      const filePath = await resolvePrivateAssetPathSecure(
        asset.storageKey,
        dependencies.privateRoot ?? defaultPrivateRoot,
      );
      if (!filePath) return new Response("Not found", { status: 404 });
      try {
        return await createPrivateFileResponse(filePath, {
          contentType: asset.mimeType,
          headers: {
            "content-disposition": `inline; filename="asset-${asset.id}"`,
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  return createPrivateFileRoute({ db: prisma }, assetId)(request);
}
