// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangePasswordForm } from "@/features/auth/components/change-password-form";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("password forms", () => {
  it.each([
    ["change", <ChangePasswordForm key="change" />],
    ["reset", <ResetPasswordForm key="reset" token="reset-token" />],
  ])("applies the shared policy before submitting the %s form", async (_name, form) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(form);

    if (screen.queryByLabelText("当前密码")) {
      fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "CurrentPass123" } });
    }
    fireEvent.change(screen.getByLabelText("新密码", { exact: true }), { target: { value: "abcdefgh" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "abcdefgh" } });
    fireEvent.submit(screen.getByLabelText("新密码", { exact: true }).closest("form")!);

    expect(await screen.findByText("密码至少 8 位，且必须同时包含英文字母和数字")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
