import { QuestionType } from "@/generated/prisma/enums";

export type SeedQuestion = {
  sequence: number;
  type: QuestionType;
  prompt: string;
  score: number;
  options: Array<{ key: string; text: string }>;
  correctKeys: string[];
};

const option = (key: string, text: string) => ({ key, text });

/**
 * Public, synthetic seed content. Replace this dataset with organization-owned
 * content outside the repository when deploying the platform.
 */
export const mockOnboardingQuestions: SeedQuestion[] = [
  {
    sequence: 1,
    type: QuestionType.SINGLE,
    prompt: "员工首次登录后，最应该先完成哪项操作？",
    score: 5,
    options: [option("A", "修改临时密码"), option("B", "关闭审计日志"), option("C", "导出全部员工"), option("D", "开启邮件自动发送")],
    correctKeys: ["A"],
  },
  {
    sequence: 2,
    type: QuestionType.SINGLE,
    prompt: "阅读制度时，员工应优先使用哪一个版本？",
    score: 5,
    options: [option("A", "已发布且适用的版本"), option("B", "任意草稿"), option("C", "本地缓存旧版本"), option("D", "未经审核的附件")],
    correctKeys: ["A"],
  },
  {
    sequence: 3,
    type: QuestionType.SINGLE,
    prompt: "导入员工名册前，最合适的步骤是什么？",
    score: 5,
    options: [option("A", "先预览并处理冲突"), option("B", "直接覆盖数据库"), option("C", "跳过格式校验"), option("D", "公开上传原始文件")],
    correctKeys: ["A"],
  },
  {
    sequence: 4,
    type: QuestionType.SINGLE,
    prompt: "私有文件下载接口的授权检查应放在哪里？",
    score: 5,
    options: [option("A", "服务端请求路径"), option("B", "仅前端按钮"), option("C", "文件名约定"), option("D", "浏览器缓存")],
    correctKeys: ["A"],
  },
  {
    sequence: 5,
    type: QuestionType.SINGLE,
    prompt: "考试答案自动保存后，服务器还应做什么？",
    score: 5,
    options: [option("A", "校验当前用户和题目归属"), option("B", "信任所有客户端字段"), option("C", "删除上一份答案"), option("D", "关闭会话校验")],
    correctKeys: ["A"],
  },
  {
    sequence: 6,
    type: QuestionType.SINGLE,
    prompt: "启用欢迎邮件自动化前，应先确认什么？",
    score: 5,
    options: [option("A", "SMTP、模板和发送开关"), option("B", "公开 SMTP 密码"), option("C", "跳过测试发送"), option("D", "删除投递记录")],
    correctKeys: ["A"],
  },
  {
    sequence: 7,
    type: QuestionType.SINGLE,
    prompt: "RBAC 权限判断的可靠依据是什么？",
    score: 5,
    options: [option("A", "服务端会话中的角色"), option("B", "URL 中的角色字符串"), option("C", "页面颜色"), option("D", "浏览器窗口尺寸")],
    correctKeys: ["A"],
  },
  {
    sequence: 8,
    type: QuestionType.SINGLE,
    prompt: "公开仓库中的数据库连接配置应如何处理？",
    score: 5,
    options: [option("A", "放在本地环境变量中"), option("B", "提交生产连接串"), option("C", "写入 README 明文"), option("D", "放入前端代码")],
    correctKeys: ["A"],
  },
  {
    sequence: 9,
    type: QuestionType.TRUE_FALSE,
    prompt: "只在前端隐藏管理员按钮，就足以完成权限保护。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["B"],
  },
  {
    sequence: 10,
    type: QuestionType.TRUE_FALSE,
    prompt: "私有文件可以通过未经授权的公开 URL 提供给员工。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["B"],
  },
  {
    sequence: 11,
    type: QuestionType.TRUE_FALSE,
    prompt: "测试邮箱可以使用 example.invalid 这类保留测试域名。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["A"],
  },
  {
    sequence: 12,
    type: QuestionType.TRUE_FALSE,
    prompt: "员工角色发生变化后，可以永远保留旧会话而不重新授权。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["B"],
  },
  {
    sequence: 13,
    type: QuestionType.TRUE_FALSE,
    prompt: "草稿制度版本可以在未发布时直接对所有员工可见。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["B"],
  },
  {
    sequence: 14,
    type: QuestionType.TRUE_FALSE,
    prompt: "公开种子数据应使用 mock 组织、员工和考试内容。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["A"],
  },
  {
    sequence: 15,
    type: QuestionType.TRUE_FALSE,
    prompt: "SMTP 返回未知结果时，可以不核验就立即批量重发。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["B"],
  },
  {
    sequence: 16,
    type: QuestionType.TRUE_FALSE,
    prompt: "审计日志不应记录明文密码或 SMTP 凭据。",
    score: 4,
    options: [option("A", "正确"), option("B", "错误")],
    correctKeys: ["A"],
  },
  {
    sequence: 17,
    type: QuestionType.MULTIPLE,
    prompt: "安全的员工名册导入通常包括哪些步骤？",
    score: 4,
    options: [option("A", "格式校验"), option("B", "重复冲突检测"), option("C", "提交前预览"), option("D", "审计记录")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 18,
    type: QuestionType.MULTIPLE,
    prompt: "私有文件保护可以包含哪些措施？",
    score: 4,
    options: [option("A", "服务端角色校验"), option("B", "路径规范化"), option("C", "文件类型校验"), option("D", "发布状态校验")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 19,
    type: QuestionType.MULTIPLE,
    prompt: "RBAC 设计需要关注哪些内容？",
    score: 4,
    options: [option("A", "角色边界"), option("B", "API 授权"), option("C", "会话失效"), option("D", "审计可追溯")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 20,
    type: QuestionType.MULTIPLE,
    prompt: "可靠的考试任务通常需要哪些能力？",
    score: 4,
    options: [option("A", "题目快照"), option("B", "时间窗口"), option("C", "答案自动保存"), option("D", "服务端评分")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 21,
    type: QuestionType.MULTIPLE,
    prompt: "邮件自动化的安全运行需要哪些控制？",
    score: 4,
    options: [option("A", "幂等键"), option("B", "租约或超时"), option("C", "有界重试"), option("D", "未知结果人工核验")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 22,
    type: QuestionType.MULTIPLE,
    prompt: "准备公开仓库时，哪些检查是必要的？",
    score: 4,
    options: [option("A", "secret 扫描"), option("B", "许可证确认"), option("C", "环境模板检查"), option("D", "依赖审计")],
    correctKeys: ["A", "B", "C", "D"],
  },
  {
    sequence: 23,
    type: QuestionType.MULTIPLE,
    prompt: "未来接入 AI 制度问答时，哪些边界应被保留？",
    score: 4,
    options: [option("A", "按用户权限检索"), option("B", "记录模型调用审计"), option("C", "明确不确定答案"), option("D", "避免把推测当制度原文")],
    correctKeys: ["A", "B", "C", "D"],
  },
];
