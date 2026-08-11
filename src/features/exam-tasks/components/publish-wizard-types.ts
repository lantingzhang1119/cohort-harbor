import type { WorkLocation } from "@/generated/prisma/enums";

export type SelectableBank = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: string;
  versionNumber: number;
  enabledScore: number;
  questionCount: number;
  updatedAt: string;
};

export type EmployeeRow = {
  id: string;
  employeeNo: string;
  name: string;
  firstDepartment: string | null;
  workLocation: WorkLocation;
  enabled: boolean;
  status: string;
};

export type AssigneePreview = {
  id: string;
  employeeNo: string;
  name: string;
  firstDepartment: string | null;
  workLocation: string;
};

export const locationLabels: Record<WorkLocation, string> = {
  SHANGHAI: "上海",
  SHENZHEN: "深圳",
  CHANGSHA: "长沙",
  XIAN: "西安",
  UNSET: "未设置",
};
