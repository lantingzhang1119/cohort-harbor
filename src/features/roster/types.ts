import type { WorkLocation } from "@/generated/prisma/enums";

export type RosterFileInput = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type NormalizedRosterRow = {
  rowNumber: number;
  employeeNo: string;
  name: string;
  firstDepartment: string | null;
  secondDepartment: string | null;
  position: string | null;
  personnelStatus: string | null;
  hiredAt: Date | null;
  leftAt: Date | null;
  email: string | null;
  workLocation: WorkLocation;
  invalidDateFields: Array<"hiredAt" | "leftAt">;
};

export type RosterIssue = {
  rowNumber: number;
  field: string;
  code: string;
  message: string;
  blocking: boolean;
};

export type RosterValidationResult = {
  valid: boolean;
  issues: RosterIssue[];
};

export type RosterBatchMetadata = {
  sourceName: string;
  originalFileName: string;
  fileHash: string;
};
