import { describe, expect, it } from "vitest";

import { ExcelRosterSource, RosterFileError } from "@/features/roster/excel-roster-source";
import { WorkLocation } from "@/generated/prisma/enums";
import { createRosterWorkbook, rosterHeaders } from "../fixtures/create-roster-workbook";

describe("ExcelRosterSource", () => {
  const source = new ExcelRosterSource();

  it.each([
    ["xls", "application/vnd.ms-excel"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ] as const)("parses fictional .%s workbooks", async (bookType, mimeType) => {
    const rows = await source.load({
      fileName: `fictional.${bookType}`,
      mimeType,
      bytes: createRosterWorkbook({ bookType }),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      employeeNo: "TEST-001",
      name: "测试员工甲",
      firstDepartment: "研发中心",
      secondDepartment: "平台部",
      position: "测试工程师",
      personnelStatus: "正式",
      email: "test001@example.invalid",
      workLocation: WorkLocation.UNSET,
    });
    expect(rows[0]?.hiredAt).toBeInstanceOf(Date);
    expect(rows[1]?.email).toBeNull();
  });

  it("reads date cells but excludes unrelated private columns", async () => {
    const rows = await source.load({
      fileName: "fictional.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createRosterWorkbook({ bookType: "xlsx" }),
    });
    expect(rows[0]?.hiredAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(rows[0]).not.toHaveProperty("age");
    expect(rows[0]).not.toHaveProperty("education");
    expect(rows[0]).not.toHaveProperty("school");
  });

  it.each([
    {
      name: "bad MIME",
      fileName: "fictional.xlsx",
      mimeType: "text/plain",
      bytes: createRosterWorkbook({ bookType: "xlsx" }),
    },
    {
      name: "bad signature",
      fileName: "fictional.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: Buffer.from("not a workbook"),
    },
    {
      name: "wrong headers",
      fileName: "fictional.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: createRosterWorkbook({
        bookType: "xlsx",
        headers: rosterHeaders.map((header) => (header === "工号" ? "员工编号" : header)),
      }),
    },
  ])("rejects $name", async (input) => {
    await expect(source.load(input)).rejects.toBeInstanceOf(RosterFileError);
  });
});
