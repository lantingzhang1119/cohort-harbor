import { describe, expect, it } from "vitest";

import { WorkLocation } from "@/generated/prisma/enums";
import { previewRosterImport } from "@/features/roster/import-preview-service";
import type { NormalizedRosterRow } from "@/features/roster/types";

function row(
  rowNumber: number,
  employeeNo: string,
  name: string,
  email: string | null,
): NormalizedRosterRow {
  return {
    rowNumber,
    employeeNo,
    name,
    email,
    firstDepartment: "测试部门",
    secondDepartment: null,
    position: "测试职位",
    personnelStatus: "正式",
    hiredAt: new Date("2026-07-01T00:00:00.000Z"),
    leftAt: null,
    workLocation: WorkLocation.UNSET,
    invalidDateFields: [],
  };
}

describe("roster import preview", () => {
  it("reports duplicates and row validation with eight counters", () => {
    const rows = [
      row(2, "TEST-501", "测试甲", "one@example.invalid"),
      row(3, "TEST-501", "测试乙", "two@example.invalid"),
      row(4, "TEST-503", "测试丙", "shared@example.invalid"),
      row(5, "TEST-504", "测试丁", "shared@example.invalid"),
      row(6, "TEST-505", "测试戊", "bad-email"),
      row(7, "", "", null),
    ];

    const result = previewRosterImport(rows);

    expect(result.summary).toEqual({
      totalRows: 6,
      validRows: 0,
      errorRows: 6,
      duplicateEmployeeNoGroups: 1,
      duplicateEmailGroups: 1,
      invalidEmailRows: 1,
      missingRequiredRows: 1,
      rehireCandidates: 0,
    });
    expect(result.conflicts.map((conflict) => conflict.type)).toEqual([
      "DUPLICATE_EMPLOYEE_NO",
      "DUPLICATE_EMAIL",
    ]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 6, code: "INVALID_EMAIL" }),
        expect.objectContaining({ rowNumber: 7, field: "employeeNo", code: "REQUIRED" }),
        expect.objectContaining({ rowNumber: 7, field: "name", code: "REQUIRED" }),
      ]),
    );
  });

  it("flags invalid Excel dates without rejecting blank optional dates", () => {
    const invalid = row(2, "TEST-510", "日期测试", null);
    invalid.invalidDateFields = ["hiredAt"];
    const result = previewRosterImport([invalid]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: "hiredAt", code: "INVALID_DATE" }),
    );
    expect(result.summary.errorRows).toBe(1);
  });

  it("rejects imported names longer than the account display-name boundary", () => {
    const result = previewRosterImport([
      row(2, "TEST-LONG-NAME", "超".repeat(81), "long-name@example.invalid"),
    ]);

    expect(result.issues).toContainEqual(expect.objectContaining({
      rowNumber: 2,
      field: "name",
      code: "TOO_LONG",
      blocking: true,
    }));
    expect(result.summary.errorRows).toBe(1);
  });
});
