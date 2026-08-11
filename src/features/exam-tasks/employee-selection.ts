import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ExamTaskError } from "@/features/exam-tasks/errors";
import type {
  AssigneeSelectionInput,
  EmployeeFilterInput,
} from "@/features/exam-tasks/schemas";

type Db = PrismaClient | Prisma.TransactionClient;

export type ResolvedAssignee = {
  id: string;
  employeeNo: string;
  name: string;
  firstDepartment: string | null;
  workLocation: string;
  status: UserStatus;
  enabled: boolean;
  role: Role;
};

const assigneeSelect = {
  id: true,
  employeeNo: true,
  name: true,
  firstDepartment: true,
  workLocation: true,
  status: true,
  enabled: true,
  role: true,
} as const;

export function isEligibleExamAssignee(
  user: Pick<ResolvedAssignee, "role" | "status" | "enabled">,
): boolean {
  return (
    user.role === Role.EMPLOYEE &&
    user.status === UserStatus.ACTIVE &&
    user.enabled
  );
}

export function buildEligibleEmployeeWhere(
  filter: EmployeeFilterInput = {},
): Prisma.UserWhereInput {
  // Publish assignment always requires login-eligible employees.
  // A UI filter of enabled=false therefore yields an empty assignee set.
  if (filter.enabled === false) {
    return {
      id: "__never__",
      role: Role.EMPLOYEE,
    };
  }
  return {
    role: Role.EMPLOYEE,
    status: UserStatus.ACTIVE,
    enabled: true,
    ...(filter.query
      ? {
          OR: [
            { employeeNo: { contains: filter.query } },
            { name: { contains: filter.query } },
          ],
        }
      : {}),
    ...(filter.department ? { firstDepartment: filter.department } : {}),
    ...(filter.location ? { workLocation: filter.location } : {}),
  };
}

export async function resolveAssigneeSelection(
  db: Db,
  selection: AssigneeSelectionInput,
): Promise<ResolvedAssignee[]> {
  if (selection.mode === "EXPLICIT") {
    const uniqueIds = [...new Set(selection.userIds)];
    if (!uniqueIds.length) {
      throw new ExamTaskError("请至少选择一名员工", "NO_ASSIGNEES");
    }
    const users = await db.user.findMany({
      where: { id: { in: uniqueIds } },
      select: assigneeSelect,
      orderBy: [{ employeeNo: "asc" }],
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    const missing = uniqueIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new ExamTaskError(
        `存在无效或不存在的员工：${missing.slice(0, 5).join("、")}`,
        "INELIGIBLE_ASSIGNEES",
      );
    }
    const ineligible = uniqueIds
      .map((id) => byId.get(id)!)
      .filter((user) => !isEligibleExamAssignee(user));
    if (ineligible.length) {
      const sample = ineligible
        .slice(0, 5)
        .map((user) => `${user.name}(${user.employeeNo})`)
        .join("、");
      throw new ExamTaskError(
        `不可分配离职、停用、不可登录或非员工账号：${sample}`,
        "INELIGIBLE_ASSIGNEES",
      );
    }
    return uniqueIds.map((id) => byId.get(id)!);
  }

  const excluded = new Set(selection.excludedUserIds);
  const where = buildEligibleEmployeeWhere(selection.filter);
  const users = await db.user.findMany({
    where,
    select: assigneeSelect,
    orderBy: [{ employeeNo: "asc" }],
  });
  const resolved = users.filter((user) => !excluded.has(user.id));
  if (!resolved.length) {
    throw new ExamTaskError("筛选结果中没有可分配的员工", "NO_ASSIGNEES");
  }
  return resolved;
}

export async function previewAssigneeSelection(
  db: Db,
  selection: AssigneeSelectionInput,
  options: { limit?: number } = {},
): Promise<{ total: number; employees: ResolvedAssignee[] }> {
  const assignees = await resolveAssigneeSelection(db, selection);
  const limit = options.limit ?? 200;
  return {
    total: assignees.length,
    employees: assignees.slice(0, limit),
  };
}
