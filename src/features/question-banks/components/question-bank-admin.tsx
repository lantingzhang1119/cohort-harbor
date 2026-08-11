"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { QuestionBankImportPanel } from "@/features/question-banks/components/question-bank-import-panel";

type BankListItem = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: "DRAFT" | "ENABLED" | "DISABLED";
  source: string;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  createdByName: string | null;
  updatedAt: string;
};

type AdminOption = { id?: string; label: string; text: string; isCorrect: boolean };
type AdminBlank = { id?: string; blankIndex: number; acceptableAnswers: string[] };
type AdminQuestion = {
  id: string;
  sequence: number;
  type: "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "FILL_BLANK";
  prompt: string;
  score: number;
  enabled: boolean;
  options: AdminOption[];
  blanks: AdminBlank[];
  dirty?: boolean;
};

type BankDetail = BankListItem & { questions: AdminQuestion[] };

const statusLabels: Record<BankListItem["status"], string> = {
  DRAFT: "草稿",
  ENABLED: "启用",
  DISABLED: "停用",
};

const sourceLabels: Record<string, string> = {
  ONLINE: "在线创建",
  WORD: "Word",
  EXCEL: "Excel",
  PDF: "PDF",
  OCR: "OCR",
  LEGACY: "历史迁移",
};

const typeLabels = {
  SINGLE_CHOICE: "单选题",
  MULTIPLE_CHOICE: "多选题",
  FILL_BLANK: "填空题",
} as const;

function emptyChoiceQuestion(sequence: number): Omit<AdminQuestion, "id"> {
  return {
    sequence,
    type: "SINGLE_CHOICE",
    prompt: "",
    score: 5,
    enabled: true,
    options: [
      { label: "A", text: "", isCorrect: true },
      { label: "B", text: "", isCorrect: false },
    ],
    blanks: [],
    dirty: true,
  };
}

function emptyFillBlank(sequence: number): Omit<AdminQuestion, "id"> {
  return {
    sequence,
    type: "FILL_BLANK",
    prompt: "",
    score: 5,
    enabled: true,
    options: [],
    blanks: [{ blankIndex: 0, acceptableAnswers: [""] }],
    dirty: true,
  };
}

export function QuestionBankAdmin() {
  const [banks, setBanks] = useState<BankListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BankDetail | null>(null);
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [message, setMessage] = useState("正在加载题库…");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const enabledTotal = useMemo(
    () => questions.filter((question) => question.enabled).reduce((sum, question) => sum + Number(question.score || 0), 0),
    [questions],
  );
  const hasUnsavedChanges = useMemo(
    () => questions.some((question) => question.dirty),
    [questions],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const loadList = useCallback(async () => {
    const response = await fetch("/api/admin/question-banks");
    const result = (await response.json()) as { ok: boolean; banks?: BankListItem[]; message?: string };
    if (!response.ok || !result.ok) {
      setMessage(result.message ?? "题库列表加载失败");
      return;
    }
    setBanks(result.banks ?? []);
    setMessage("");
  }, []);

  const loadDetail = useCallback(async (bankId: string) => {
    const response = await fetch(`/api/admin/question-banks/${bankId}`);
    const result = (await response.json()) as { ok: boolean; bank?: BankDetail; message?: string };
    if (!response.ok || !result.ok || !result.bank) {
      setMessage(result.message ?? "题库详情加载失败");
      return;
    }
    setDetail(result.bank);
    setQuestions(
      result.bank.questions.map((question) => ({
        ...question,
        options: question.options ?? [],
        blanks: question.blanks ?? [],
        dirty: false,
      })),
    );
    setMessage("");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/question-banks", { signal: controller.signal })
      .then((response) => response.json())
      .then((result: { ok: boolean; banks?: BankListItem[]; message?: string }) => {
        setBanks(result.banks ?? []);
        setMessage(result.ok ? "" : result.message ?? "题库列表加载失败");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function createBlank() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/question-banks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim() || "新建空白题库" }),
      });
      const result = (await response.json()) as { ok: boolean; bank?: BankListItem; message?: string };
      setMessage(result.ok ? "空白题库已创建" : result.message ?? "创建失败");
      if (result.ok && result.bank) {
        setNewName("");
        await loadList();
        setSelectedId(result.bank.id);
        await loadDetail(result.bank.id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyBank(bankId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/question-banks/${bankId}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await response.json()) as { ok: boolean; bank?: BankListItem; message?: string };
      setMessage(result.ok ? "题库已复制为草稿" : result.message ?? "复制失败");
      if (result.ok && result.bank) {
        await loadList();
        setSelectedId(result.bank.id);
        await loadDetail(result.bank.id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(bankId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/question-banks/${bankId}/default`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await response.json()) as { message?: string };
      setMessage(response.ok ? "已设为全公司默认题库" : result.message ?? "设置默认失败");
      if (response.ok) {
        await loadList();
        if (selectedId === bankId) await loadDetail(bankId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(bankId: string, status: BankListItem["status"]) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/question-banks/${bankId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = (await response.json()) as { message?: string };
      setMessage(response.ok ? `题库已${statusLabels[status]}` : result.message ?? "状态更新失败");
      if (response.ok) {
        await loadList();
        if (selectedId === bankId) await loadDetail(bankId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeBank(bankId: string) {
    if (!window.confirm("确认将此题库移入软删除？默认题库受保护。")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/question-banks/${bankId}`, { method: "DELETE" });
      const result = (await response.json()) as { message?: string };
      setMessage(response.ok ? "题库已删除" : result.message ?? "删除失败");
      if (response.ok) {
        if (selectedId === bankId) {
          setSelectedId(null);
          setDetail(null);
          setQuestions([]);
        }
        await loadList();
      }
    } finally {
      setBusy(false);
    }
  }

  function markDirty(id: string, patch: Partial<AdminQuestion>) {
    setQuestions((current) =>
      current.map((question) =>
        question.id === id ? { ...question, ...patch, dirty: true } : question,
      ),
    );
  }

  function updateOption(questionId: string, index: number, patch: Partial<AdminOption>) {
    setQuestions((current) =>
      current.map((question) => {
        if (question.id !== questionId) return question;
        return {
          ...question,
          dirty: true,
          options: question.options.map((option, optionIndex) =>
            optionIndex === index ? { ...option, ...patch } : option,
          ),
        };
      }),
    );
  }

  function setCorrect(question: AdminQuestion, index: number, checked: boolean) {
    markDirty(question.id, {
      options: question.options.map((option, optionIndex) => ({
        ...option,
        isCorrect:
          question.type === "MULTIPLE_CHOICE"
            ? optionIndex === index
              ? checked
              : option.isCorrect
            : optionIndex === index,
      })),
    });
  }

  function changeType(question: AdminQuestion, type: AdminQuestion["type"]) {
    if (type === "FILL_BLANK") {
      markDirty(question.id, {
        type,
        options: [],
        blanks: question.blanks.length
          ? question.blanks
          : [{ blankIndex: 0, acceptableAnswers: [""] }],
      });
      return;
    }
    markDirty(question.id, {
      type,
      blanks: [],
      options: question.options.length >= 2
        ? question.options.map((option, index) => ({
            ...option,
            isCorrect: type === "SINGLE_CHOICE" ? index === 0 : index < 2,
          }))
        : [
            { label: "A", text: "", isCorrect: true },
            { label: "B", text: "", isCorrect: type === "MULTIPLE_CHOICE" },
          ],
    });
  }

  async function saveQuestion(question: AdminQuestion) {
    if (!detail) return;
    if (question.dirty && question.id.startsWith("tmp-") === false) {
      // existing dirty save continues
    }
    setBusy(true);
    try {
      const payload = {
        type: question.type,
        prompt: question.prompt,
        score: Number(question.score),
        enabled: question.enabled,
        options:
          question.type === "FILL_BLANK"
            ? undefined
            : question.options.map((option) => ({
                label: option.label,
                text: option.text,
                isCorrect: option.isCorrect,
              })),
        blanks:
          question.type === "FILL_BLANK"
            ? question.blanks.map((blank) => ({
                blankIndex: blank.blankIndex,
                acceptableAnswers: blank.acceptableAnswers,
              }))
            : undefined,
      };

      const isNew = question.id.startsWith("tmp-");
      const response = await fetch(
        isNew
          ? `/api/admin/question-banks/${detail.id}/questions`
          : `/api/admin/question-banks/${detail.id}/questions/${question.id}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const result = (await response.json()) as { ok: boolean; message?: string };
      if (!response.ok || !result.ok) {
        setMessage(result.message ?? "题目保存失败，已保留当前输入");
        return;
      }
      setMessage(`第 ${question.sequence} 题已保存`);
      await loadDetail(detail.id);
      await loadList();
    } finally {
      setBusy(false);
    }
  }

  async function addQuestion(type: AdminQuestion["type"] = "SINGLE_CHOICE") {
    if (!detail) return;
    const sequence = questions.length + 1;
    const draft =
      type === "FILL_BLANK" ? emptyFillBlank(sequence) : emptyChoiceQuestion(sequence);
    if (type === "MULTIPLE_CHOICE" && draft.options) {
      draft.options = draft.options.map((option, index) => ({
        ...option,
        isCorrect: index < 2,
      }));
      draft.type = "MULTIPLE_CHOICE";
    }
    const temp: AdminQuestion = { ...draft, id: `tmp-${Date.now()}-${sequence}`, type: draft.type };
    setQuestions((current) => [...current, temp]);
  }

  async function deleteQuestion(question: AdminQuestion) {
    if (!detail) return;
    if (question.id.startsWith("tmp-")) {
      setQuestions((current) => current.filter((item) => item.id !== question.id));
      return;
    }
    if (!window.confirm(`确认删除第 ${question.sequence} 题？`)) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/question-banks/${detail.id}/questions/${question.id}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as { message?: string };
      setMessage(response.ok ? "题目已删除" : result.message ?? "删除失败");
      if (response.ok) {
        await loadDetail(detail.id);
        await loadList();
      }
    } finally {
      setBusy(false);
    }
  }

  async function moveQuestion(questionId: string, direction: -1 | 1) {
    if (!detail) return;
    const index = questions.findIndex((item) => item.id === questionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= questions.length) return;
    if (questions.some((item) => item.id.startsWith("tmp-") || item.dirty)) {
      setMessage("请先保存未完成的题目，再调整顺序");
      return;
    }
    const ordered = questions.slice();
    const [item] = ordered.splice(index, 1);
    ordered.splice(target, 0, item!);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/question-banks/${detail.id}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedQuestionIds: ordered.map((question) => question.id) }),
      });
      const result = (await response.json()) as { message?: string };
      setMessage(response.ok ? "题目顺序已更新" : result.message ?? "排序失败");
      if (response.ok) await loadDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  function updateBlankAnswers(questionId: string, blankIndex: number, raw: string) {
    setQuestions((current) =>
      current.map((question) => {
        if (question.id !== questionId) return question;
        return {
          ...question,
          dirty: true,
          blanks: question.blanks.map((blank) =>
            blank.blankIndex === blankIndex
              ? {
                  ...blank,
                  acceptableAnswers: raw.split("|").map((part) => part),
                }
              : blank,
          ),
        };
      }),
    );
  }

  function addBlank(question: AdminQuestion) {
    const nextIndex =
      question.blanks.reduce((max, blank) => Math.max(max, blank.blankIndex), -1) + 1;
    markDirty(question.id, {
      blanks: [...question.blanks, { blankIndex: nextIndex, acceptableAnswers: [""] }],
    });
  }

  function removeBlank(question: AdminQuestion, blankIndex: number) {
    if (question.blanks.length <= 1) {
      setMessage("填空题至少一个空格");
      return;
    }
    markDirty(question.id, {
      blanks: question.blanks
        .filter((blank) => blank.blankIndex !== blankIndex)
        .map((blank, index) => ({ ...blank, blankIndex: index })),
    });
  }

  async function openBank(bankId: string) {
    if (questions.some((question) => question.dirty)) {
      if (!window.confirm("当前有未保存的题目修改，离开将丢失这些修改。继续？")) return;
    }
    setSelectedId(bankId);
    await loadDetail(bankId);
  }

  return (
    <main className="admin-content">
      <header className="page-title-row">
        <div>
          <p className="eyebrow">EXAM · 题库管理</p>
          <h1>多题库管理</h1>
          <p>
            支持多套题库、全公司唯一默认题库，以及单选/多选/填空的在线编辑。启用前启用题目总分必须为 100 分。
            可上传 Word / Excel / PDF，经复核确认后写入可编辑题库。
          </p>
        </div>
      </header>

      <p className="status-message" role="status">
        {message}
      </p>

      <section className="question-bank-toolbar" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          aria-label="新建题库名称"
          placeholder="新建空白题库名称"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          style={{ minWidth: 220, padding: "8px 12px", borderRadius: 10, border: "1px solid #bdd8e6" }}
        />
        <button className="primary-action" type="button" disabled={busy} onClick={() => void createBlank()}>
          新建空白题库
        </button>
      </section>

      <QuestionBankImportPanel
        onMessage={setMessage}
        onConfirmed={async (bank) => {
          await loadList();
          setSelectedId(bank.id);
          await loadDetail(bank.id);
        }}
      />

      <section className="question-bank-list" style={{ display: "grid", gap: 12, marginBottom: 28 }}>
        {banks.length === 0 && <p className="empty-note">暂无题库，请先新建空白题库。</p>}
        {banks.map((bank) => (
          <article
            key={bank.id}
            className="question-editor"
            style={{
              border: selectedId === bank.id ? "2px solid var(--blue)" : "1px solid var(--line)",
              borderRadius: 16,
              padding: 16,
              background: "#fff",
            }}
          >
            <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <strong>{bank.name}</strong>
                {bank.isDefault && (
                  <small style={{ marginLeft: 8, color: "#08704a", fontWeight: 800 }}>默认题库</small>
                )}
                <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
                  {statusLabels[bank.status]} · {sourceLabels[bank.source] ?? bank.source} · 题目{" "}
                  {bank.questionCount} · 启用总分 {bank.enabledScore}
                  {bank.createdByName ? ` · 创建人 ${bank.createdByName}` : ""}
                  {" · "}
                  更新 {new Date(bank.updatedAt).toLocaleString("zh-CN")}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => void openBank(bank.id)}>
                  编辑
                </button>
                <button type="button" disabled={busy} onClick={() => void copyBank(bank.id)}>
                  复制
                </button>
                <button
                  type="button"
                  disabled={busy || bank.isDefault || bank.status !== "ENABLED" || bank.enabledScore !== 100}
                  title={bank.status !== "ENABLED" || bank.enabledScore !== 100 ? "题库需先达到 100 分并启用" : undefined}
                  onClick={() => void setDefault(bank.id)}
                >
                  设为默认
                </button>
                {bank.status !== "ENABLED" ? (
                  <button type="button" disabled={busy} onClick={() => void changeStatus(bank.id, "ENABLED")}>
                    启用
                  </button>
                ) : (
                  <button type="button" disabled={busy || bank.isDefault} onClick={() => void changeStatus(bank.id, "DISABLED")}>
                    停用
                  </button>
                )}
                <button type="button" disabled={busy || bank.isDefault} onClick={() => void removeBank(bank.id)}>
                  删除
                </button>
              </div>
            </header>
          </article>
        ))}
      </section>

      {detail && (
        <section className="question-bank-editor">
          <header className="page-title-row" style={{ marginBottom: 12 }}>
            <div>
              <p className="eyebrow">编辑题库</p>
              <h2 style={{ margin: 0 }}>{detail.name}</h2>
              <p>
                {detail.isDefault ? "当前为默认题库 · " : ""}
                状态 {statusLabels[detail.status]} · 版本 v{detail.versionNumber}
              </p>
            </div>
          </header>

          <div className={`question-total ${enabledTotal === 100 ? "valid" : "invalid"}`}>
            <span>当前启用题目总分</span>
            <strong>{enabledTotal}</strong>
            <small>
              {enabledTotal === 100
                ? "可启用"
                : `需调整为 100 分（差额 ${100 - enabledTotal}）`}
            </small>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "16px 0" }}>
            <button type="button" disabled={busy} onClick={() => void addQuestion("SINGLE_CHOICE")}>
              ＋ 单选题
            </button>
            <button type="button" disabled={busy} onClick={() => void addQuestion("MULTIPLE_CHOICE")}>
              ＋ 多选题
            </button>
            <button type="button" disabled={busy} onClick={() => void addQuestion("FILL_BLANK")}>
              ＋ 填空题
            </button>
          </div>

          <section className="question-admin-list">
            {questions.map((question, index) => (
              <article className="question-editor" key={question.id}>
                <header>
                  <span>{String(question.sequence).padStart(2, "0")}</span>
                  <div className="question-meta-fields">
                    <label>
                      题型
                      <select
                        value={question.type}
                        onChange={(event) =>
                          changeType(question, event.target.value as AdminQuestion["type"])
                        }
                      >
                        <option value="SINGLE_CHOICE">单选题</option>
                        <option value="MULTIPLE_CHOICE">多选题</option>
                        <option value="FILL_BLANK">填空题</option>
                      </select>
                    </label>
                    <label>
                      分值
                      <input
                        type="number"
                        min={1}
                        value={question.score}
                        onChange={(event) =>
                          markDirty(question.id, { score: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={question.enabled}
                        onChange={(event) =>
                          markDirty(question.id, { enabled: event.target.checked })
                        }
                      />
                      启用
                    </label>
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      className="primary-action"
                      type="button"
                      disabled={busy}
                      onClick={() => void saveQuestion(question)}
                    >
                      保存本题{question.dirty ? " *" : ""}
                    </button>
                    <button type="button" disabled={busy || index === 0} onClick={() => void moveQuestion(question.id, -1)}>
                      上移
                    </button>
                    <button
                      type="button"
                      disabled={busy || index === questions.length - 1}
                      onClick={() => void moveQuestion(question.id, 1)}
                    >
                      下移
                    </button>
                    <button type="button" disabled={busy} onClick={() => void deleteQuestion(question)}>
                      删除
                    </button>
                  </div>
                </header>

                <label className="question-prompt-field">
                  <span>{typeLabels[question.type]}题干</span>
                  <textarea
                    value={question.prompt}
                    onChange={(event) => markDirty(question.id, { prompt: event.target.value })}
                  />
                </label>

                {question.type !== "FILL_BLANK" ? (
                  <>
                    <section className="question-option-editors">
                      {question.options.map((option, optionIndex) => (
                        <div key={`${question.id}-${optionIndex}`}>
                          <input
                            className="option-key"
                            aria-label={`第${question.sequence}题选项键`}
                            value={option.label}
                            maxLength={3}
                            onChange={(event) =>
                              updateOption(question.id, optionIndex, {
                                label: event.target.value.toUpperCase(),
                              })
                            }
                          />
                          <input
                            className="option-text"
                            aria-label={`第${question.sequence}题选项${option.label}内容`}
                            value={option.text}
                            onChange={(event) =>
                              updateOption(question.id, optionIndex, { text: event.target.value })
                            }
                          />
                          <label className={option.isCorrect ? "correct-answer-control" : ""}>
                            <input
                              type={question.type === "MULTIPLE_CHOICE" ? "checkbox" : "radio"}
                              name={`correct-${question.id}`}
                              checked={option.isCorrect}
                              onChange={(event) =>
                                setCorrect(question, optionIndex, event.target.checked)
                              }
                            />
                            正确答案
                          </label>
                          <button
                            type="button"
                            aria-label={`删除选项${option.label}`}
                            onClick={() => {
                              if (question.options.length <= 2) {
                                setMessage("每道题至少需要两个选项");
                                return;
                              }
                              markDirty(question.id, {
                                options: question.options.filter((_, i) => i !== optionIndex),
                              });
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </section>
                    <button
                      className="add-option-action"
                      type="button"
                      onClick={() => {
                        const label = String.fromCharCode(65 + question.options.length);
                        markDirty(question.id, {
                          options: [
                            ...question.options,
                            { label, text: "", isCorrect: false },
                          ],
                        });
                      }}
                    >
                      ＋ 新增选项
                    </button>
                  </>
                ) : (
                  <section className="question-option-editors">
                    {question.blanks.map((blank) => (
                      <div key={`${question.id}-blank-${blank.blankIndex}`}>
                        <span style={{ minWidth: 64, fontWeight: 700 }}>空{blank.blankIndex + 1}</span>
                        <input
                          className="option-text"
                          aria-label={`第${question.sequence}题空${blank.blankIndex + 1}可接受答案`}
                          placeholder="多个可接受答案用 | 分隔"
                          value={blank.acceptableAnswers.join("|")}
                          onChange={(event) =>
                            updateBlankAnswers(question.id, blank.blankIndex, event.target.value)
                          }
                          style={{ flex: 1 }}
                        />
                        <button type="button" onClick={() => removeBlank(question, blank.blankIndex)}>
                          删除空格
                        </button>
                      </div>
                    ))}
                    <button className="add-option-action" type="button" onClick={() => addBlank(question)}>
                      ＋ 新增空格
                    </button>
                  </section>
                )}
              </article>
            ))}
          </section>
        </section>
      )}
    </main>
  );
}
