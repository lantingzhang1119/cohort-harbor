import type { Prisma, User } from "@/generated/prisma/client";

export function snapshotUserIdentity(
  user: Pick<User, "id" | "employeeNo" | "name" | "email" | "role">,
): Prisma.InputJsonObject {
  return {
    id: user.id,
    employeeNo: user.employeeNo,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}
