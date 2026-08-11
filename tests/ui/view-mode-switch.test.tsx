// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionViewMode } from "@/generated/prisma/enums";
import { ViewModeSwitch } from "@/lib/ui/view-mode-switch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ViewModeSwitch", () => {
  it("prevents overlapping requests while a switch is pending", async () => {
    let resolveResponse!: (value: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolveResponse = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ViewModeSwitch targetMode={SessionViewMode.EMPLOYEE} />);

    const button = screen.getByRole("button", { name: "切换到员工端" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("正在切换…")).toBeTruthy();
    resolveResponse(new Response(JSON.stringify({ ok: false, message: "切换失败" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    expect(await screen.findByText("切换失败")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["network", () => Promise.reject(new Error("offline"))],
    ["non-json", () => Promise.resolve(new Response("proxy failure", { status: 502 }))],
  ])("shows a visible %s error", async (_case, response) => {
    vi.stubGlobal("fetch", vi.fn(response));
    render(<ViewModeSwitch targetMode={SessionViewMode.ADMIN} />);

    fireEvent.click(screen.getByRole("button", { name: "切换到管理端" }));

    expect((await screen.findByRole("alert")).textContent).toBe("切换失败，请稍后重试");
  });
});
