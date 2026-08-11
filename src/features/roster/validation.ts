import { z } from "zod";

import type { NormalizedRosterRow, RosterIssue } from "@/features/roster/types";

const emailSchema = z.string().email();

export function validateRosterRows(rows: NormalizedRosterRow[]): RosterIssue[] {
  return rows.flatMap((row) => {
    const issues: RosterIssue[] = [];
    if (!row.employeeNo) {
      issues.push({ rowNumber: row.rowNumber, field: "employeeNo", code: "REQUIRED", message: "工号不能为空", blocking: true });
    }
    if (!row.name) {
      issues.push({ rowNumber: row.rowNumber, field: "name", code: "REQUIRED", message: "姓名不能为空", blocking: true });
    } else if (row.name.length > 80) {
      issues.push({ rowNumber: row.rowNumber, field: "name", code: "TOO_LONG", message: "姓名不能超过 80 个字符", blocking: true });
    }
    if (row.email && !emailSchema.safeParse(row.email).success) {
      issues.push({ rowNumber: row.rowNumber, field: "email", code: "INVALID_EMAIL", message: "邮箱格式不正确", blocking: true });
    }
    for (const field of row.invalidDateFields) {
      issues.push({ rowNumber: row.rowNumber, field, code: "INVALID_DATE", message: field === "hiredAt" ? "入职日期格式不正确" : "离职日期格式不正确", blocking: true });
    }
    return issues;
  });
}

export function groupedRows(
  rows: NormalizedRosterRow[],
  key: (row: NormalizedRosterRow) => string | null,
) {
  const groups = new Map<string, NormalizedRosterRow[]>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    const existing = groups.get(value) ?? [];
    existing.push(row);
    groups.set(value, existing);
  }
  return [...groups.entries()].filter(([, members]) => members.length > 1);
}
