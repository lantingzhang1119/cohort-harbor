import type { Metadata } from "next";

import { AdminAccountManager } from "@/features/admin-accounts/components/admin-account-manager";
import { requirePageUser } from "@/lib/auth/server-session";

export const metadata: Metadata = { title: "管理员账号" };

export default async function AdministratorsPage() {
  await requirePageUser("SUPER_ADMIN_ACCESS");
  return <AdminAccountManager />;
}
