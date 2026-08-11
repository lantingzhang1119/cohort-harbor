import type { ReactNode } from "react";

import { requirePageUser } from "@/lib/auth/server-session";

export const dynamic = "force-dynamic";

export default async function PortalEditorLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requirePageUser("ADMIN_ACCESS");

  return children;
}
