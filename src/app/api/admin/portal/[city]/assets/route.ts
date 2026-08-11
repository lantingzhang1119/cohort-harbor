import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { City } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { MAX_PORTAL_IMAGE_BYTES } from "@/features/portal/portal-file-validation";
import { readBoundedBody } from "@/features/portal/portal-request-body";
import { portalErrorResponse } from "@/features/portal/portal-route-utils";
import { deletePortalAsset, listPortalAssets, uploadPortalAsset } from "@/features/portal/portal-service";
import { defaultPrivateRoot } from "@/lib/storage/private-storage";
import { prisma } from "@/lib/db/client";

const portalAssetCategorySchema = z.enum([
  "LOGO",
  "BACKGROUND",
  "OFFICE_MAP",
  "IMAGE",
  "ICON",
  "ILLUSTRATION",
]);
const MAX_PORTAL_MULTIPART_BYTES = MAX_PORTAL_IMAGE_BYTES + 64 * 1024;

export function createPortalAssetRoute(
  { db, privateRoot = defaultPrivateRoot }: { db: PrismaClient; privateRoot?: string },
  city: City,
) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        return NextResponse.json({ ok: true, assets: await listPortalAssets(db, city) });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const bytes = await readBoundedBody(request, MAX_PORTAL_MULTIPART_BYTES, {
          // Node's native multipart producer can enqueue after cancellation;
          // stop pulling and release the lock instead.
          cancelOnLimit: false,
        });
        const form = await new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: bytes,
        }).formData();
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) {
          return NextResponse.json({ ok: false, message: "请选择门户素材文件" }, { status: 400 });
        }
        const category = portalAssetCategorySchema.parse(form.get("category") ?? "IMAGE");
        const asset = await uploadPortalAsset(db, {
          fileName: file.name,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }, actor.id, privateRoot, { category });
        return NextResponse.json({ ok: true, asset }, { status: 201 });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
    async DELETE(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const assetId = new URL(request.url).searchParams.get("assetId");
        if (!assetId) return NextResponse.json({ ok: false, message: "缺少素材 ID" }, { status: 400 });
        await deletePortalAsset(db, assetId, actor.id, privateRoot);
        return NextResponse.json({ ok: true });
      } catch (error) {
        return portalErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

function validCity(value: string): value is City { return Object.values(City).includes(value as City); }

export async function GET(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalAssetRoute({ db: prisma }, city).GET(request);
}
export async function POST(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalAssetRoute({ db: prisma }, city).POST(request);
}
export async function DELETE(request: Request, context: { params: Promise<{ city: string }> }) {
  const { city } = await context.params;
  if (!validCity(city)) return NextResponse.json({ ok: false, message: "城市不存在" }, { status: 404 });
  return createPortalAssetRoute({ db: prisma }, city).DELETE(request);
}
