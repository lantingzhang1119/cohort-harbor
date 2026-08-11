export function ScheduleStep({
  name,
  description,
  startsAtLocal,
  endsAtLocal,
  passingScore,
  onNameChange,
  onDescriptionChange,
  onStartsAtChange,
  onEndsAtChange,
  onPassingScoreChange,
}: {
  name: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  passingScore: number;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onStartsAtChange: (value: string) => void;
  onEndsAtChange: (value: string) => void;
  onPassingScoreChange: (value: number) => void;
}) {
  return (
    <section className="exam-task-step-card" aria-label="时间与规则">
      <header>
        <h2>3. 时间与规则</h2>
        <p>时间按 Asia/Shanghai（中国上海）填写与展示；数据库以 UTC 保存。</p>
      </header>
      <div className="mail-form-grid exam-task-form-grid">
        <label>
          考试名称
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="例如：2026 入职安全考试"
            maxLength={120}
          />
        </label>
        <label>
          及格分（默认 80）
          <input
            type="number"
            min={1}
            max={100}
            value={passingScore}
            onChange={(event) => onPassingScoreChange(Number(event.target.value))}
          />
        </label>
        <label>
          开始时间（上海）
          <input
            type="datetime-local"
            value={startsAtLocal}
            onChange={(event) => onStartsAtChange(event.target.value)}
          />
        </label>
        <label>
          结束时间（上海）
          <input
            type="datetime-local"
            value={endsAtLocal}
            onChange={(event) => onEndsAtChange(event.target.value)}
          />
        </label>
        <label className="full-width">
          任务说明（可选）
          <textarea
            rows={3}
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="补充考试要求、注意事项等"
            maxLength={2000}
          />
        </label>
      </div>
      <p className="hint-text">时区提示：Asia/Shanghai · 补考规则沿用现有 80 分与一次补考策略。</p>
    </section>
  );
}
