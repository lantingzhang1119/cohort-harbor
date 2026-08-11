/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuestionBankAdmin } from "@/features/question-banks/components/question-bank-admin";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("question bank admin import entry points", () => {
  it("exposes upload, processing status and review/confirm controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/api/admin/question-banks")) {
          return new Response(JSON.stringify({ ok: true, banks: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    render(<QuestionBankAdmin />);

    expect(await screen.findByRole("button", { name: /导入题库|上传题库/i })).toBeTruthy();
    expect(screen.getAllByText(/标准模板|Word|Excel/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/处理状态|导入状态|复核/i).length).toBeGreaterThan(0);
  });

  it("requires an explicit source review confirmation instead of clearing review on edit", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/admin/question-banks") && !init?.method) {
          return new Response(JSON.stringify({ ok: true, banks: [] }), { status: 200 });
        }
        if (url.endsWith("/api/admin/question-banks/import") && init?.method === "POST") {
          return new Response(JSON.stringify({
            ok: true,
            job: {
              id: "job-1",
              status: "REVIEW_READY",
              stage: "REVIEW",
              originalName: "uncertain.pdf",
              bankName: "OCR 导入题库",
              warnings: [{ message: "OCR 结果需要人工复核" }],
              questions: [{
                localId: "question-1",
                sequence: 1,
                type: "SINGLE_CHOICE",
                prompt: "待复核题干",
                score: 100,
                options: [
                  { label: "A", text: "甲", isCorrect: true },
                  { label: "B", text: "乙", isCorrect: false },
                ],
                blanks: [],
                needsReview: true,
                reviewReasons: ["OCR 识别结果"],
                originalSnippet: "原文片段",
              }],
            },
          }), { status: 201 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    render(<QuestionBankAdmin />);
    await screen.findByRole("button", { name: "上传题库" });
    await user.upload(
      screen.getByLabelText("选择题库导入文件"),
      new File(["%PDF-test"], "uncertain.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "上传题库" }));

    const confirmation = await screen.findByRole("checkbox", {
      name: /我已对照原文核对本题/,
    });
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    const prompt = screen.getByLabelText("导入题 1 题干");
    await user.clear(prompt);
    await user.type(prompt, "人工修正后的题干");
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("需要复核")).toBeTruthy();
  });
});
