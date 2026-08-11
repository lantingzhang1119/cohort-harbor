import { requirePageUser } from "@/lib/auth/server-session";

import { PortalEditorClient } from "./portal-editor-client";

const CITY_CODES = ["SHANGHAI", "SHENZHEN", "CHANGSHA", "XIAN"] as const;

export default async function PortalEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string; viewport?: string }>;
}) {
  const [user, query] = await Promise.all([
    requirePageUser("ADMIN_ACCESS"),
    searchParams,
  ]);
  const initialCity = CITY_CODES.find((city) => city === query.city) ?? "SHANGHAI";
  const initialViewport = query.viewport === "MOBILE" ? "MOBILE" : "DESKTOP";

  return (
    <PortalEditorClient
      userId={user.id}
      initialCity={initialCity}
      initialViewport={initialViewport}
    />
  );
}
