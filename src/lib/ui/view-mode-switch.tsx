"use client";

import { useRef, useState } from "react";

import { SessionViewMode } from "@/generated/prisma/enums";

type SwitchResponse = {
  ok?: boolean;
  redirectTo?: "/admin" | "/employee";
  message?: string;
};

export function ViewModeSwitch({ targetMode }: { targetMode: SessionViewMode }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = targetMode === SessionViewMode.ADMIN ? "切换到管理端" : "切换到员工端";

  async function switchMode() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/view-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetMode }),
      });
      let result: SwitchResponse;
      try {
        result = await response.json() as SwitchResponse;
      } catch {
        throw new Error("NON_JSON_RESPONSE");
      }
      if (!response.ok || !result.ok || !result.redirectTo) {
        setError(result.message ?? "切换失败，请稍后重试");
        return;
      }
      window.location.assign(result.redirectTo);
    } catch {
      setError("切换失败，请稍后重试");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="view-mode-control">
      <button type="button" disabled={busy} onClick={() => void switchMode()}>
        {busy ? "正在切换…" : label}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
