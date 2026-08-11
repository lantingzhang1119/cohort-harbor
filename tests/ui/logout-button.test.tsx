// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recoveryKey } from "@/features/portal/editor/editor-recovery";
import { LogoutButton } from "@/lib/ui/logout-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("LogoutButton", () => {
  it("clears portal recovery even when the editor is unmounted and dispatches the cleanup event", async () => {
    const recovery = recoveryKey("admin-real-id", "SHANGHAI", "DESKTOP");
    window.sessionStorage.setItem(recovery, "privileged draft");
    window.sessionStorage.setItem("unrelated", "keep");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      redirectTo: "#logged-out",
    })));
    const cleanupEvent = vi.fn();
    window.addEventListener("portal-recovery-clear", cleanupEvent);

    render(<LogoutButton />);
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(cleanupEvent).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(recovery)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    window.removeEventListener("portal-recovery-clear", cleanupEvent);
  });
});
