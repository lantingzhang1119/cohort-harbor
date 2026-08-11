import type { PrismaClient } from "@/generated/prisma/client";
import type { AssignmentStatus, WorkLocation } from "@/generated/prisma/enums";
import { Role } from "@/generated/prisma/enums";
import { csvCell } from "@/features/reminders/csv";
import { InAppSender } from "@/features/reminders/in-app-sender";
import { SimulatedEmailSender } from "@/features/reminders/simulated-email-sender";

export type ReminderTarget = {
  assignmentId: string;
  userId: string;
  employeeNo: string;
  name: string;
  email: string | null;
  department: string | null;
  location: WorkLocation;
  status: AssignmentStatus;
  dueAt: Date;
};

export async function listReminderTargets(
  db: PrismaClient,
  filters: {
    statuses?: AssignmentStatus[];
    department?: string;
    location?: WorkLocation;
    dueBefore?: Date;
  },
): Promise<ReminderTarget[]> {
  const assignments = await db.examAssignment.findMany({
    where: {
      ...(filters.statuses?.length ? { status: { in: filters.statuses } } : {}),
      ...(filters.dueBefore ? { dueAt: { lte: filters.dueBefore } } : {}),
      user: {
        role: Role.EMPLOYEE,
        enabled: true,
        ...(filters.department ? { firstDepartment: filters.department } : {}),
        ...(filters.location ? { workLocation: filters.location } : {}),
      },
    },
    include: { user: true },
    orderBy: { dueAt: "asc" },
  });
  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    userId: assignment.userId,
    employeeNo: assignment.user.employeeNo,
    name: assignment.user.name,
    email: assignment.user.email,
    department: assignment.user.firstDepartment,
    location: assignment.user.workLocation,
    status: assignment.status,
    dueAt: assignment.dueAt,
  }));
}

export async function sendReminder(
  db: PrismaClient,
  input: {
    recipientIds: string[];
    actorId: string;
    channels: Array<"IN_APP" | "SIMULATED_EMAIL">;
  },
) {
  const recipients = [...new Set(input.recipientIds)].map((userId) => ({ userId }));
  let inAppCount = 0;
  let simulatedEmailCount = 0;
  if (input.channels.includes("IN_APP")) {
    inAppCount = await new InAppSender(db).send(recipients, input.actorId);
  }
  if (input.channels.includes("SIMULATED_EMAIL")) {
    simulatedEmailCount = await new SimulatedEmailSender(db).send(recipients, input.actorId);
  }
  return { inAppCount, simulatedEmailCount };
}

export function exportReminderCsv(targets: ReminderTarget[]) {
  const rows = [
    ["工号", "姓名", "部门", "工作地点", "任务状态", "截止日期", "邮箱"],
    ...targets.map((target) => [
      target.employeeNo,
      target.name,
      target.department,
      target.location,
      target.status,
      target.dueAt.toISOString(),
      target.email,
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
