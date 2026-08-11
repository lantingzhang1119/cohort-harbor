import { NextResponse } from "next/server";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { snapshotUserIdentity } from "@/features/admin-accounts/identity-snapshot";
import { assertSameOrigin } from "@/features/auth/origin";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { onboardingMailErrorResponse } from "@/features/onboarding-mail/admin-route-utils";
import { validateFieldConfig } from "@/features/onboarding-mail/field-registry";
import { mailFieldConfigSchema } from "@/features/onboarding-mail/template-schemas";
import { prisma } from "@/lib/db/client";

const schema = z.object({ fields: mailFieldConfigSchema.array().min(1).max(100) });

function publicFieldConfig(field: {
  key: string;
  kind: "BUILTIN" | "CONSTANT";
  label: string;
  enabled: boolean;
  sortOrder: number;
  required: boolean;
  dateFormat: string | null;
  constantValue: string | null;
}) {
  return mailFieldConfigSchema.parse({
    key: field.key,
    kind: field.kind,
    label: field.label,
    enabled: field.enabled,
    sortOrder: field.sortOrder,
    required: field.required,
    dateFormat: field.dateFormat,
    constantValue: field.constantValue,
  });
}

async function listPublicFields(db: PrismaClient) {
  const fields = await db.onboardingMailField.findMany({ orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  return fields.map(publicFieldConfig);
}

export function createOnboardingMailFieldsRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        return NextResponse.json({ ok: true, fields: await listPublicFields(db) });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const fields = validateFieldConfig(schema.parse(await request.json()).fields);
        await db.$transaction(async (transaction) => {
          for (const field of fields) await transaction.onboardingMailField.upsert({ where: { key: field.key }, create: {
            key: field.key,
            kind: field.kind,
            builtIn: field.kind === "BUILTIN",
            label: field.label,
            enabled: field.enabled,
            sortOrder: field.sortOrder,
            dateFormat: field.dateFormat ?? null,
            required: field.required,
            constantValue: field.constantValue ?? null,
            updatedById: actor.id,
            updatedBySnapshot: snapshotUserIdentity(actor),
          }, update: {
            label: field.label,
            enabled: field.enabled,
            sortOrder: field.sortOrder,
            dateFormat: field.dateFormat ?? null,
            required: field.required,
            constantValue: field.constantValue ?? null,
            updatedById: actor.id,
            updatedBySnapshot: snapshotUserIdentity(actor),
          } });
        });
        return NextResponse.json({ ok: true, fields: await listPublicFields(db) });
      } catch (error) { return onboardingMailErrorResponse(error); }
    },
  };
}
const route = createOnboardingMailFieldsRoute({ db: prisma });
export const GET = route.GET;
export const PATCH = route.PATCH;
