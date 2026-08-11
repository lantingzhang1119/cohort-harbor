import { NextResponse } from "next/server";
import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import { EmployeeModuleKey } from "@/generated/prisma/enums";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import {
  EMPLOYEE_MODULE_DEFINITIONS,
} from "@/features/employee-modules/module-definitions";
import {
  getEnabledEmployeeModules,
  updateEmployeeModules,
} from "@/features/employee-modules/module-service";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

const inputSchema = z.object({
  enabledKeys: z.array(z.enum(EmployeeModuleKey)).superRefine((keys, context) => {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "板块不能重复" });
    }
  }),
}).strict();

export function createEmployeeModuleSettingsRoute({ db }: { db: PrismaClient }) {
  return {
    async GET(request: Request) {
      try {
        await requireAdminRequest(db, request);
        const enabled = await getEnabledEmployeeModules(db);
        return NextResponse.json({
          ok: true,
          enabledKeys: EMPLOYEE_MODULE_DEFINITIONS
            .filter(({ key }) => enabled.has(key))
            .map(({ key }) => key),
          modules: EMPLOYEE_MODULE_DEFINITIONS,
        });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
    async PATCH(request: Request) {
      try {
        assertSameOrigin(request);
        const actor = await requireAdminRequest(db, request);
        const input = inputSchema.parse(await request.json());
        await updateEmployeeModules(actor.id, input.enabledKeys, db);
        return NextResponse.json({ ok: true, enabledKeys: input.enabledKeys });
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof TypeError) {
          return NextResponse.json(
            { ok: false, message: "员工端板块设置格式无效" },
            { status: 400 },
          );
        }
        return authErrorResponse(error);
      }
    },
  };
}

const route = createEmployeeModuleSettingsRoute({ db: prisma });
export const GET = route.GET;
export const PATCH = route.PATCH;
