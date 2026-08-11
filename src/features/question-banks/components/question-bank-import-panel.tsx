"use client";

import { useState } from "react";
import Link from "next/link";

type QuestionType = "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "FILL_BLANK";

type ImportDraftQuestion = {
  localId: string;
  sequence: number;
  type: QuestionType | null;
  prompt: string;
  score: number | null;
  options: Array<{ label: string; text: string; isCorrect: boolean | null }>;
  blanks: Array<{ blankIndex: number; acceptableAnswers: string[] }>;
  needsReview: boolean;
  reviewReasons: string[];
  reviewConfirmed?: boolean;
  originalSnippet: string;
};

type ImportJobView = {
  id: string;
  status: string;
  stage: string;
  originalName: string;
  bankName: string;
  warnings: Array<{ message: string }>;
  questions: ImportDraftQuestion[];
  errorMessage?: string | null;
};

type ConfirmedBank = { id: string; name: string };

function nextOptionLabel(index: number) {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function typePatch(question: ImportDraftQuestion, type: QuestionType): Partial<ImportDraftQuestion> {
  if (type === "FILL_BLANK") {
    return {
      type,
      options: [],
      blanks: question.blanks.length ? question.blanks : [{ blankIndex: 0, acceptableAnswers: [""] }],
    };
  }
  return {
    type,
    blanks: [],
    options: question.options.length >= 2
      ? question.options
      : [
          { label: "A", text: "", isCorrect: true },
          { label: "B", text: "", isCorrect: false },
        ],
  };
}

export function QuestionBankImportPanel(props: {
  onConfirmed(bank: ConfirmedBank): Promise<void>;
  onMessage(message: string): void;
}) {
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [bankName, setBankName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function patchQuestion(localId: string, patch: Partial<ImportDraftQuestion>) {
    setJob((current) => current && ({
      ...current,
      questions: current.questions.map((question) =>
        question.localId === localId
          ? {
              ...question,
              ...patch,
              reviewConfirmed: question.needsReview ? false : question.reviewConfirmed,
            }
          : question,
      ),
    }));
  }

  async function upload() {
    if (!file) {
      props.onMessage("请先选择 Word / Excel / PDF 题库文件");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/admin/question-banks/import", { method: "POST", body: form });
      const result = (await response.json()) as { ok: boolean; job?: ImportJobView; message?: string };
      if (!response.ok || !result.ok || !result.job) {
        props.onMessage(result.message ?? "题库导入失败");
        return;
      }
      setJob(result.job);
      setBankName(result.job.bankName || result.job.originalName);
      props.onMessage(`导入处理完成，当前阶段：${result.job.stage}`);
    } catch {
      props.onMessage("题库导入请求失败，请检查本地服务后重试");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(): Promise<ImportJobView | null> {
    if (!job) return null;
    const response = await fetch(`/api/admin/question-banks/import/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bankName, questions: job.questions }),
    });
    const result = (await response.json()) as { ok: boolean; job?: ImportJobView; message?: string };
    if (!response.ok || !result.ok || !result.job) {
      props.onMessage(result.message ?? "导入草稿保存失败");
      return null;
    }
    setJob(result.job);
    setBankName(result.job.bankName);
    return result.job;
  }

  async function save() {
    setBusy(true);
    try {
      const saved = await saveDraft();
      if (saved) props.onMessage("导入草稿已保存，可继续逐题复核");
    } catch {
      props.onMessage("导入草稿保存请求失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!job) return;
    setBusy(true);
    try {
      const saved = await saveDraft();
      if (!saved) return;
      if (saved.questions.some((question) => question.needsReview)) {
        props.onMessage("仍有题目需要复核或校验未通过，请逐题修正并勾选“已核对”");
        return;
      }
      const response = await fetch(`/api/admin/question-banks/import/${job.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankName: bankName || saved.bankName }),
      });
      const result = (await response.json()) as { ok: boolean; bank?: ConfirmedBank; message?: string };
      if (!response.ok || !result.ok || !result.bank) {
        props.onMessage(result.message ?? "确认导入失败，未生成正式题库");
        return;
      }
      setJob(null);
      setFile(null);
      setBankName("");
      props.onMessage(`已确认写入可编辑题库：${result.bank.name}`);
      await props.onConfirmed(result.bank);
    } catch {
      props.onMessage("确认导入请求失败，未生成正式题库");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="question-bank-import-panel" aria-labelledby="question-bank-import-title">
      <header>
        <strong id="question-bank-import-title">题库文件导入与复核</strong>
        <p>标准模板确定性解析；任意格式尽力识别，不确定项必须人工复核。扫描 PDF 使用本地 OCR。</p>
      </header>
      <div className="question-bank-import-actions">
        <Link className="button-link" href="/api/admin/question-banks/import/templates/word">下载标准 Word 模板</Link>
        <Link className="button-link" href="/api/admin/question-banks/import/templates/excel">下载标准 Excel 模板</Link>
        <Link className="button-link" href="/api/admin/question-banks/import/templates/instructions">填写说明</Link>
      </div>
      <div className="question-bank-import-actions">
        <input
          type="file"
          accept=".doc,.docx,.xls,.xlsx,.pdf"
          aria-label="选择题库导入文件"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button className="primary-action" type="button" disabled={busy} onClick={() => void upload()}>
          {busy ? "处理中…" : "上传题库"}
        </button>
      </div>
      <p className="question-bank-import-status" aria-live="polite">
        处理状态：{job ? `${job.status} / 阶段 ${job.stage}` : "尚未导入"}
        {job?.errorMessage ? ` · ${job.errorMessage}` : ""}
      </p>

      {job && (
        <div className="question-bank-import-review">
          <label className="question-bank-import-name">
            <span>导入题库名称</span>
            <input value={bankName} onChange={(event) => setBankName(event.target.value)} />
          </label>
          {job.warnings.length > 0 && (
            <ul className="question-bank-import-warnings">
              {job.warnings.map((warning, index) => (
                <li key={`${warning.message}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          )}
          {job.questions.map((question) => (
            <article
              className={`question-bank-import-question${question.needsReview ? " is-review-needed" : ""}`}
              key={question.localId}
            >
              <div className="question-bank-import-question-head">
                <strong>第 {question.sequence} 题</strong>
                {question.needsReview && <span className="review-badge">需要复核</span>}
                <select
                  aria-label={`导入题 ${question.sequence} 题型`}
                  value={question.type ?? "SINGLE_CHOICE"}
                  onChange={(event) =>
                    patchQuestion(question.localId, typePatch(question, event.target.value as QuestionType))
                  }
                >
                  <option value="SINGLE_CHOICE">单选</option>
                  <option value="MULTIPLE_CHOICE">多选</option>
                  <option value="FILL_BLANK">填空</option>
                </select>
                <input
                  type="number"
                  min="1"
                  step="1"
                  aria-label={`导入题 ${question.sequence} 分值`}
                  value={question.score ?? ""}
                  onChange={(event) => patchQuestion(question.localId, {
                    score: event.target.value ? Number(event.target.value) : null,
                  })}
                />
                <button
                  className="danger-link"
                  type="button"
                  onClick={() => setJob((current) => current && ({
                    ...current,
                    questions: current.questions
                      .filter((item) => item.localId !== question.localId)
                      .map((item, index) => ({ ...item, sequence: index + 1 })),
                  }))}
                >
                  移除此题
                </button>
              </div>
              <textarea
                aria-label={`导入题 ${question.sequence} 题干`}
                value={question.prompt}
                onChange={(event) => patchQuestion(question.localId, { prompt: event.target.value })}
                rows={2}
              />

              {question.type !== "FILL_BLANK" && (
                <div className="question-bank-import-options">
                  {question.options.map((option, optionIndex) => (
                    <div className="question-bank-import-option" key={`${question.localId}-${option.label}-${optionIndex}`}>
                      <input
                        aria-label={`${option.label} 为正确答案`}
                        type={question.type === "MULTIPLE_CHOICE" ? "checkbox" : "radio"}
                        name={`import-correct-${question.localId}`}
                        checked={option.isCorrect === true}
                        onChange={(event) => {
                          const options = question.options.map((item, index) => ({
                            ...item,
                            isCorrect: question.type === "MULTIPLE_CHOICE"
                              ? index === optionIndex ? event.target.checked : item.isCorrect === true
                              : index === optionIndex,
                          }));
                          patchQuestion(question.localId, { options });
                        }}
                      />
                      <span>{option.label}.</span>
                      <input
                        aria-label={`选项 ${option.label} 内容`}
                        value={option.text}
                        onChange={(event) => patchQuestion(question.localId, {
                          options: question.options.map((item, index) =>
                            index === optionIndex ? { ...item, text: event.target.value } : item,
                          ),
                        })}
                      />
                      <button
                        type="button"
                        disabled={question.options.length <= 2}
                        onClick={() => patchQuestion(question.localId, {
                          options: question.options
                            .filter((_, index) => index !== optionIndex)
                            .map((item, index) => ({ ...item, label: nextOptionLabel(index) })),
                        })}
                      >
                        删除选项
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={question.options.length >= 8}
                    onClick={() => patchQuestion(question.localId, {
                      options: [
                        ...question.options,
                        { label: nextOptionLabel(question.options.length), text: "", isCorrect: false },
                      ],
                    })}
                  >
                    新增选项
                  </button>
                </div>
              )}

              {question.type === "FILL_BLANK" && (
                <div className="question-bank-import-blanks">
                  {question.blanks.map((blank, blankIndex) => (
                    <div className="question-bank-import-blank" key={`${question.localId}-blank-${blankIndex}`}>
                      <label>
                        <span>空格 {blankIndex + 1} 可接受答案（| 分隔）</span>
                        <input
                          value={blank.acceptableAnswers.join("|")}
                          onChange={(event) => patchQuestion(question.localId, {
                            blanks: question.blanks.map((item, index) => index === blankIndex
                              ? { ...item, acceptableAnswers: event.target.value.split("|") }
                              : item),
                          })}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={question.blanks.length <= 1}
                        onClick={() => patchQuestion(question.localId, {
                          blanks: question.blanks
                            .filter((_, index) => index !== blankIndex)
                            .map((item, index) => ({ ...item, blankIndex: index })),
                        })}
                      >
                        删除空格
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => patchQuestion(question.localId, {
                      blanks: [...question.blanks, { blankIndex: question.blanks.length, acceptableAnswers: [""] }],
                    })}
                  >
                    新增空格
                  </button>
                </div>
              )}

              {question.reviewReasons.length > 0 && (
                <p className="question-bank-import-reasons">{question.reviewReasons.join("；")}</p>
              )}
              {question.needsReview && (
                <label className="question-bank-review-confirmation">
                  <input
                    type="checkbox"
                    checked={question.reviewConfirmed === true}
                    onChange={(event) => setJob((current) => current && ({
                      ...current,
                      questions: current.questions.map((item) => item.localId === question.localId
                        ? { ...item, reviewConfirmed: event.target.checked }
                        : item),
                    }))}
                  />
                  我已对照原文核对本题题型、题干、选项、答案和分值
                </label>
              )}
              {question.originalSnippet && (
                <details>
                  <summary>原文片段</summary>
                  <pre>{question.originalSnippet}</pre>
                </details>
              )}
            </article>
          ))}
          <div className="question-bank-import-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>保存复核草稿</button>
            <button className="primary-action" type="button" disabled={busy} onClick={() => void confirm()}>
              确认写入题库
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
