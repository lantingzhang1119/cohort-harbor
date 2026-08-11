"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { clearPortalRecoveryAfterLogout } from "@/features/portal/editor/editor-recovery";

export function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const result = (await response.json()) as { redirectTo?: string };
      if (response.ok) clearPortalRecoveryAfterLogout();
      window.location.assign(result.redirectTo ?? "/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="shell-logout" type="button" onClick={() => void logout()} disabled={busy}>
      <LogOut aria-hidden="true" size={17} />
      <span>{busy ? "退出中…" : "退出登录"}</span>
    </button>
  );
}
