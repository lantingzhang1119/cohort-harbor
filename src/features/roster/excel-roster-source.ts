import { createHash } from "node:crypto";
import path from "node:path";

import * as XLSX from "xlsx";

import { WorkLocation } from "@/generated/prisma/enums";
import type { RosterSource } from "@/features/roster/roster-source";
import type {
  NormalizedRosterRow,
  RosterFileInput,
  RosterValidationResult,
} from "@/features/roster/types";

const requiredHeaders = [
  "工号",
  "姓名",
  "一级部门",
  "二级部门",
  "岗位",
  "人员状态",
  "入职日期",
  "离职日期",
  "邮箱",
] as const;

const acceptedMimeTypes = {
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export class RosterFileError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_EXTENSION"
      | "INVALID_MIME"
      | "INVALID_SIGNATURE"
      | "WORKBOOK_EMPTY"
      | "INVALID_HEADERS"
      | "FILE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "RosterFileError";
  }
}

function hasSignature(extension: ".xls" | ".xlsx", bytes: Uint8Array) {
  if (extension === ".xlsx") {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return ole.every((value, index) => bytes[index] === value);
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function optionalText(value: unknown): string | null {
  return text(value) || null;
}

function dateValue(value: unknown): { value: Date | null; invalid: boolean } {
  if (value === null || value === undefined || value === "") return { value: null, invalid: false };
  if (value instanceof Date) return Number.isNaN(value.getTime())
    ? { value: null, invalid: true }
    : { value, invalid: false };
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return { value: null, invalid: true };
    return {
      value: new Date(
        Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S)),
      ),
      invalid: false,
    };
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime())
    ? { value: null, invalid: true }
    : { value: parsed, invalid: false };
}

export class ExcelRosterSource implements RosterSource<RosterFileInput> {
  getSourceName() {
    return "ExcelRosterSource";
  }

  async load(input: RosterFileInput): Promise<NormalizedRosterRow[]> {
    if (input.bytes.byteLength > 20 * 1024 * 1024) {
      throw new RosterFileError("FILE_TOO_LARGE", "Excel 文件不能超过 20 MB");
    }
    const extension = path.extname(input.fileName).toLowerCase();
    if (extension !== ".xls" && extension !== ".xlsx") {
      throw new RosterFileError("UNSUPPORTED_EXTENSION", "仅支持 .xls 和 .xlsx 文件");
    }
    if (input.mimeType !== acceptedMimeTypes[extension]) {
      throw new RosterFileError("INVALID_MIME", "文件类型与扩展名不一致");
    }
    if (!hasSignature(extension, input.bytes)) {
      throw new RosterFileError("INVALID_SIGNATURE", "文件签名无效，无法作为 Excel 读取");
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(input.bytes, { type: "array", cellDates: true });
    } catch {
      throw new RosterFileError("INVALID_SIGNATURE", "Excel 文件已损坏或无法读取");
    }
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new RosterFileError("WORKBOOK_EMPTY", "工作簿中没有工作表");
    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) throw new RosterFileError("WORKBOOK_EMPTY", "工作表为空");
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const headerRow = matrix[0]?.map(text) ?? [];
    const missingHeaders = requiredHeaders.filter((header) => !headerRow.includes(header));
    if (missingHeaders.length) {
      throw new RosterFileError(
        "INVALID_HEADERS",
        `表头缺少：${missingHeaders.join("、")}`,
      );
    }
    const column = Object.fromEntries(headerRow.map((header, index) => [header, index]));

    return matrix.slice(1).map((row, index) => {
      const hiredAt = dateValue(row[column["入职日期"]]);
      const leftAt = dateValue(row[column["离职日期"]]);
      return {
        rowNumber: index + 2,
        employeeNo: text(row[column["工号"]]),
        name: text(row[column["姓名"]]),
        firstDepartment: optionalText(row[column["一级部门"]]),
        secondDepartment: optionalText(row[column["二级部门"]]),
        position: optionalText(row[column["岗位"]]),
        personnelStatus: optionalText(row[column["人员状态"]]),
        hiredAt: hiredAt.value,
        leftAt: leftAt.value,
        email: optionalText(row[column["邮箱"]])?.toLowerCase() ?? null,
        workLocation: WorkLocation.UNSET,
        invalidDateFields: [
          ...(hiredAt.invalid ? (["hiredAt"] as const) : []),
          ...(leftAt.invalid ? (["leftAt"] as const) : []),
        ],
      };
    });
  }

  async validate(rows: NormalizedRosterRow[]): Promise<RosterValidationResult> {
    const issues = rows.flatMap((row) => {
      const rowIssues = [];
      if (!row.employeeNo) rowIssues.push({ rowNumber: row.rowNumber, field: "employeeNo", code: "REQUIRED", message: "工号不能为空", blocking: true });
      if (!row.name) rowIssues.push({ rowNumber: row.rowNumber, field: "name", code: "REQUIRED", message: "姓名不能为空", blocking: true });
      return rowIssues;
    });
    return { valid: issues.length === 0, issues };
  }

  async createBatchMetadata(input: RosterFileInput) {
    return {
      sourceName: this.getSourceName(),
      originalFileName: path.basename(input.fileName),
      fileHash: createHash("sha256").update(input.bytes).digest("hex"),
    };
  }
}
