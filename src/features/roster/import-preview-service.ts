import type { NormalizedRosterRow } from "@/features/roster/types";
import { groupedRows, validateRosterRows } from "@/features/roster/validation";

export type PreviewConflict = {
  type: "DUPLICATE_EMPLOYEE_NO" | "DUPLICATE_EMAIL";
  key: string;
  rowNumbers: number[];
};

export function previewRosterImport(
  rows: NormalizedRosterRow[],
  options: { departedEmployeeNos?: ReadonlySet<string> } = {},
) {
  const issues = validateRosterRows(rows);
  const duplicateEmployeeNos = groupedRows(rows, (row) => row.employeeNo || null);
  const duplicateEmails = groupedRows(rows, (row) => row.email?.toLowerCase() ?? null);
  const conflicts: PreviewConflict[] = [
    ...duplicateEmployeeNos.map(([key, members]) => ({
      type: "DUPLICATE_EMPLOYEE_NO" as const,
      key,
      rowNumbers: members.map((row) => row.rowNumber),
    })),
    ...duplicateEmails.map(([key, members]) => ({
      type: "DUPLICATE_EMAIL" as const,
      key,
      rowNumbers: members.map((row) => row.rowNumber),
    })),
  ];
  const errorRows = new Set(issues.filter((issue) => issue.blocking).map((issue) => issue.rowNumber));
  for (const conflict of conflicts) {
    for (const rowNumber of conflict.rowNumbers) errorRows.add(rowNumber);
  }
  const missingRequiredRows = new Set(
    issues.filter((issue) => issue.code === "REQUIRED").map((issue) => issue.rowNumber),
  ).size;
  const invalidEmailRows = new Set(
    issues.filter((issue) => issue.code === "INVALID_EMAIL").map((issue) => issue.rowNumber),
  ).size;
  const rehireCandidates = rows.filter(
    (row) => row.employeeNo && options.departedEmployeeNos?.has(row.employeeNo),
  ).length;

  return {
    rows,
    issues,
    conflicts,
    summary: {
      totalRows: rows.length,
      validRows: rows.length - errorRows.size,
      errorRows: errorRows.size,
      duplicateEmployeeNoGroups: duplicateEmployeeNos.length,
      duplicateEmailGroups: duplicateEmails.length,
      invalidEmailRows,
      missingRequiredRows,
      rehireCandidates,
    },
  };
}
