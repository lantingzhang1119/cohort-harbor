import { AssignmentStatus, WorkLocation } from "@/generated/prisma/enums";
import { authErrorResponse } from "@/features/auth/route-utils";
import { requireAdminRequest } from "@/features/employees/route-utils";
import { exportReminderCsv, listReminderTargets } from "@/features/reminders/reminder-service";
import { prisma } from "@/lib/db/client";

export async function GET(request: Request) {
  try {
    await requireAdminRequest(prisma, request);
    const url = new URL(request.url);
    const statusText = url.searchParams.get("status");
    const locationText = url.searchParams.get("location");
    const csv = exportReminderCsv(await listReminderTargets(prisma, {
      statuses: statusText && Object.values(AssignmentStatus).includes(statusText as AssignmentStatus) ? [statusText as AssignmentStatus] : undefined,
      department: url.searchParams.get("department") ?? undefined,
      location: locationText && Object.values(WorkLocation).includes(locationText as WorkLocation) ? locationText as WorkLocation : undefined,
    }));
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=reminders.csv", "cache-control": "private, no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
