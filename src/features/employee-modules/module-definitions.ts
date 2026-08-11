import { EmployeeModuleKey } from "@/generated/prisma/enums";

export type EmployeeModuleDefinition = {
  key: EmployeeModuleKey;
  label: string;
  shortLabel: string;
  description: string;
  href: string;
};

export const EMPLOYEE_MODULE_DEFINITIONS: readonly EmployeeModuleDefinition[] = [
  {
    key: EmployeeModuleKey.GUIDES,
    label: "四城指南",
    shortLabel: "指南",
    description: "办公、交通与城市生活指南",
    href: "/employee/guides",
  },
  {
    key: EmployeeModuleKey.ONBOARDING_KIT,
    label: "入职资料包",
    shortLabel: "资料包",
    description: "下载入职所需的文件资料",
    href: "/employee/onboarding-kit",
  },
  {
    key: EmployeeModuleKey.POLICIES,
    label: "制度学习",
    shortLabel: "制度",
    description: "阅读本岗位适用的公司制度",
    href: "/employee/policies",
  },
  {
    key: EmployeeModuleKey.EXAM,
    label: "学习考试",
    shortLabel: "考试",
    description: "完成入职知识学习考试",
    href: "/employee/exam",
  },
  {
    key: EmployeeModuleKey.RESULTS,
    label: "考试结果",
    shortLabel: "结果",
    description: "查看个人考试记录与成绩",
    href: "/employee/results",
  },
  {
    key: EmployeeModuleKey.RETAKE,
    label: "补考申请",
    shortLabel: "补考",
    description: "查看补考状态并提交申请",
    href: "/employee/retake",
  },
  {
    key: EmployeeModuleKey.NOTIFICATIONS,
    label: "通知",
    shortLabel: "通知",
    description: "查看学习催办与系统消息",
    href: "/employee/notifications",
  },
] as const;

export const EMPLOYEE_MODULE_KEYS = EMPLOYEE_MODULE_DEFINITIONS.map(
  ({ key }) => key,
) as readonly EmployeeModuleKey[];

export const EMPLOYEE_MODULE_DEFINITION_BY_KEY = new Map(
  EMPLOYEE_MODULE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isEmployeeModuleKey(value: unknown): value is EmployeeModuleKey {
  return typeof value === "string" && EMPLOYEE_MODULE_DEFINITION_BY_KEY.has(
    value as EmployeeModuleKey,
  );
}

export function getEmployeeNavigationItems(
  enabledKeys: ReadonlySet<EmployeeModuleKey>,
): EmployeeModuleDefinition[] {
  return EMPLOYEE_MODULE_DEFINITIONS.filter(({ key }) => enabledKeys.has(key));
}

export function employeePageDecision(
  enabledKeys: ReadonlySet<EmployeeModuleKey>,
  key: EmployeeModuleKey,
): string | null {
  return enabledKeys.has(key) ? null : "/employee?notice=module-closed";
}
