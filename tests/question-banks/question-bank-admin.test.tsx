// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuestionBankAdmin } from "@/features/question-banks/components/question-bank-admin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("question bank admin", () => {
  it("keeps save available, persists edits, and warns before leaving with unsaved changes", async () => {
    const bank = {
      id: "bank-1",
      name: "测试题库",
      description: null,
      isDefault: false,
      status: "DRAFT",
      source: "ONLINE",
      versionNumber: 1,
      enabledScore: 5,
      questionCount: 1,
      createdByName: "管理员",
      updatedAt: new Date().toISOString(),
      questions: [{
        id: "question-1",
        sequence: 1,
        type: "SINGLE_CHOICE",
        prompt: "原题干",
        score: 5,
        enabled: true,
        options: [
          { id: "a", label: "A", text: "正确", isCorrect: true },
          { id: "b", label: "B", text: "错误", isCorrect: false },
        ],
        blanks: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/question-banks" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ ok: true, banks: [bank] }));
      }
      if (url === "/api/admin/question-banks/bank-1" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ ok: true, bank }));
      }
      if (url.endsWith("/questions/question-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true, question: bank.questions[0] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<QuestionBankAdmin />);
    expect(await screen.findByText("测试题库")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const prompt = await screen.findByDisplayValue("原题干");
    fireEvent.change(prompt, { target: { value: "已修改但未保存" } });

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);

    const save = screen.getByRole("button", { name: /保存本题/ });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/question-banks/bank-1/questions/question-1",
      expect.objectContaining({ method: "PATCH" }),
    ));
  });
});
