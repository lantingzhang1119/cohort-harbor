import type { SelectableBank } from "@/features/exam-tasks/components/publish-wizard-types";

export function BankSelectionStep({
  banks,
  defaultBankId,
  questionBankId,
  onSelect,
}: {
  banks: SelectableBank[];
  defaultBankId: string | null;
  questionBankId: string;
  onSelect: (bankId: string) => void;
}) {
  return (
    <section className="exam-task-step-card" aria-label="选择题库">
      <header>
        <h2>1. 选择题库</h2>
        <p>仅展示已启用、满 100 分且题目与答案校验通过的题库。默认题库会自动选中，可改选。</p>
      </header>
      <p className="hint-text">
        {defaultBankId
          ? `当前默认题库：${banks.find((bank) => bank.id === defaultBankId)?.name ?? defaultBankId}`
          : "尚未设置可用的默认题库，请手动选择。"}
      </p>
      <ul className="exam-task-bank-list">
        {banks.map((bank) => (
          <li key={bank.id}>
            <label className={questionBankId === bank.id ? "selected" : ""}>
              <input
                type="radio"
                name="questionBank"
                value={bank.id}
                checked={questionBankId === bank.id}
                onChange={() => onSelect(bank.id)}
              />
              <div>
                <strong>
                  {bank.name}
                  {bank.isDefault ? <span className="tag success">默认</span> : null}
                </strong>
                <p>
                  {bank.questionCount} 题 · 总分 {bank.enabledScore} · 版本 v{bank.versionNumber}
                  {" · 更新 "}
                  {new Date(bank.updatedAt).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </p>
                {bank.description ? <p>{bank.description}</p> : null}
              </div>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
