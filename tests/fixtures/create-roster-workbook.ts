import * as XLSX from "xlsx";

export const rosterHeaders = [
  "工号",
  "姓名",
  "年龄",
  "一级部门",
  "二级部门",
  "岗位",
  "人员状态",
  "入职日期",
  "学历",
  "毕业院校",
  "专业",
  "离职日期",
  "邮箱",
];

export function createRosterWorkbook(options: {
  bookType: "xls" | "xlsx";
  rows?: unknown[][];
  headers?: string[];
  sheetName?: string;
}) {
  const rows =
    options.rows ??
    [
      [
        "TEST-001",
        "测试员工甲",
        28,
        "研发中心",
        "平台部",
        "测试工程师",
        "正式",
        new Date("2026-07-01T00:00:00.000Z"),
        "本科",
        "示例大学",
        "计算机",
        null,
        "test001@example.invalid",
      ],
      [
        "TEST-002",
        "测试员工乙",
        29,
        "产品中心",
        "产品部",
        "产品经理",
        "试用期",
        new Date("2026-07-02T00:00:00.000Z"),
        "本科",
        "示例学院",
        "设计",
        null,
        "",
      ],
    ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([options.headers ?? rosterHeaders, ...rows]),
    options.sheetName ?? "Sheet1",
  );
  return Buffer.from(
    XLSX.write(workbook, {
      type: "buffer",
      bookType: options.bookType,
      cellDates: true,
    }),
  );
}
