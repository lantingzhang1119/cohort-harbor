import { NextResponse } from "next/server";

import type { PrismaClient } from "@/generated/prisma/client";
import { AssignmentStatus } from "@/generated/prisma/enums";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { prisma } from "@/lib/db/client";

export function createAdminResultsRoute({ db }: { db: PrismaClient }) {
  return async function GET(request: Request) {
    try {
      await requireAdminRequest(db, request);
      const params = new URL(request.url).searchParams;
      const statusText = params.get("status");
      const status = Object.values(AssignmentStatus).find((value) => value === statusText);
      const employee = params.get("employee")?.trim() || undefined;
      const task = params.get("task")?.trim() || undefined;
      const bank = params.get("bank")?.trim() || undefined;
      const assignments = await db.examAssignment.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(employee
            ? { user: { OR: [{ name: { contains: employee } }, { employeeNo: { contains: employee } }] } }
            : {}),
        },
        include: {
          user: { select: { id: true, employeeNo: true, name: true, firstDepartment: true, workLocation: true } },
          exam: { select: { name: true, passingScore: true } },
          attempts: { orderBy: { attemptNo: "desc" } },
        },
        orderBy: { updatedAt: "desc" },
      });
      const taskAssignments = await db.examTaskAssignment.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(employee
            ? { user: { OR: [{ name: { contains: employee } }, { employeeNo: { contains: employee } }] } }
            : {}),
          task: {
            ...(task ? { name: { contains: task } } : {}),
            ...(bank ? { snapshot: { questionBankName: { contains: bank } } } : {}),
          },
        },
        include: {
          user: {
            select: {
              id: true,
              employeeNo: true,
              name: true,
              firstDepartment: true,
              workLocation: true,
            },
          },
          task: {
            select: {
              id: true,
              name: true,
              passingScore: true,
              snapshot: { select: { questionBankName: true, questionBankVersion: true } },
            },
          },
          attempts: { orderBy: { attemptNo: "desc" }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
      });
      return NextResponse.json({ ok: true, assignments, taskAssignments });
    } catch (error) {
      return authErrorResponse(error);
    }
  };
}

export const GET = createAdminResultsRoute({ db: prisma });
