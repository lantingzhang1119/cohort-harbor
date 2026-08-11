import type { ReactNode } from "react";

import { requirePageUser } from "@/lib/auth/server-session";
import { AppShell } from "@/lib/ui/app-shell";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser("ADMIN_ACCESS");
  return <AppShell variant="admin" user={user}>{children}</AppShell>;
}
