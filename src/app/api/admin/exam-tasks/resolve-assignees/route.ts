import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { assertSameOrigin } from "@/features/auth/origin";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { previewAssigneeSelection } from "@/features/exam-tasks/employee-selection";
import { ExamTaskError } from "@/features/exam-tasks/errors";
import { examTaskErrorResponse } from "@/features/exam-tasks/route-utils";
import {
  assigneeSelectionSchema,
  type AssigneeSelectionInput,
} from "@/features/exam-tasks/schemas";
import { prisma } from "@/lib/db/client";

type RouteDeps = { db: PrismaClient };

export function createAdminExamTaskResolveAssigneesRoute(
  deps: RouteDeps = { db: prisma },
) {
  return {
    async POST(request: Request) {
      try {
        assertSameOrigin(request);
        await requireAdminRequest(deps.db, request);
        const body = (await request.json()) as { selection?: AssigneeSelectionInput };
        let selection: AssigneeSelectionInput;
        try {
          selection = assigneeSelectionSchema.parse(body.selection);
        } catch {
          throw new ExamTaskError("员工选择参数无效", "VALIDATION_ERROR");
        }
        const result = await previewAssigneeSelection(deps.db, selection);
        return NextResponse.json({
          ok: true,
          total: result.total,
          employees: result.employees.map((employee) => ({
            id: employee.id,
            employeeNo: employee.employeeNo,
            name: employee.name,
            firstDepartment: employee.firstDepartment,
            workLocation: employee.workLocation,
          })),
        });
      } catch (error) {
        return examTaskErrorResponse(error) ?? authErrorResponse(error);
      }
    },
  };
}

const route = createAdminExamTaskResolveAssigneesRoute();
export const POST = (request: Request) => route.POST(request);
