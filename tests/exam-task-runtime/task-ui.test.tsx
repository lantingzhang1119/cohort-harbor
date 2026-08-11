// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskLanding } from "@/features/exam-task-runtime/components/task-landing";
import { TaskRunner } from "@/features/exam-task-runtime/components/task-runner";
import { ResultsList } from "@/features/exams/components/results-list";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("employee exam task UI", () => {
  it("replaces a closed deep-linked attempt with a results action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: "ATTEMPT_CLOSED",
      message: "考试已经提交",
    }), { status: 409 })));
    render(<TaskRunner attemptId="closed-attempt" />);
    expect(await screen.findByText("考试已经提交")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看考试结果" }).getAttribute("href")).toBe("/employee/results");
    expect(screen.queryByRole("button", { name: "提交试卷" })).toBeNull();
  });

  it("labels an empty legacy-result section without contradicting task results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, assignments: [] }))));
    render(<ResultsList />);
    expect(await screen.findByText("暂无历史考试记录")).toBeTruthy();
    expect(screen.queryByText("暂无考试记录")).toBeNull();
  });

  it("renders assigned task status and the four business facts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      tasks: [{
        id: "assignment-1",
        displayStatus: "PENDING",
        currentAttemptCount: 0,
        score: null,
        task: {
          name: "入职安全考试",
          description: "请按时完成",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-08-10T00:00:00.000Z",
          passingScore: 80,
          questionBankName: "安全题库",
          questionBankVersion: 2,
          questionCount: 12,
          totalScore: 100,
        },
        latestAttempt: null,
      }],
    }))));
    render(<TaskLanding isManagementAccount={false} hasLegacyAssignment={false} />);
    expect(await screen.findByRole("heading", { name: "我的考试任务" })).toBeTruthy();
    expect(await screen.findByText("入职安全考试")).toBeTruthy();
    expect(screen.getByText("待完成")).toBeTruthy();
    expect(screen.getByText("安全题库 · v2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始考试" })).toBeTruthy();
  });

  it("renders single/multiple/fill controls and auto-saves a choice", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ ok: true, answer: { savedAt: new Date().toISOString() } }));
      }
      return new Response(JSON.stringify({
        ok: true,
        attemptId: "attempt-1",
        taskName: "安全考试",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        watermarkName: "示例员工",
        watermarkOpacity: 0.07,
        answers: {},
        questions: [
          {
            id: "q1",
            sequence: 1,
            type: "SINGLE_CHOICE",
            prompt: "总部在哪？",
            score: 40,
            options: [{ id: "o1", label: "A", text: "上海" }],
            blankCount: 0,
          },
          {
            id: "q2",
            sequence: 2,
            type: "FILL_BLANK",
            prompt: "填写城市",
            score: 60,
            options: [],
            blankCount: 2,
          },
        ],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TaskRunner attemptId="attempt-1" />);
    expect(await screen.findByRole("heading", { name: "总部在哪？" })).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: /上海/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/exam/task-attempts/attempt-1/answer",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText(/已自动保存/)).toBeTruthy();
  });
});
