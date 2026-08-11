import { describe, expect, it } from "vitest";

import { PolicyFileError, validatePolicyFile } from "@/features/policies/file-validation";

const pdf = new Uint8Array(Buffer.from("%PDF-1.7\nfixture\n%%EOF"));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("policy file validation", () => {
  it.each([
    ["handbook.pdf", "application/pdf", pdf, "PDF"],
    ["handbook.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "OFFICE"],
    ["handbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "OFFICE"],
    ["handbook.ppt", "application/vnd.ms-powerpoint", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "OFFICE"],
    ["poster.png", "image/png", png, "IMAGE"],
    ["directory.csv", "text/csv", new TextEncoder().encode("姓名,部门\n甲,研发"), "CSV"],
    ["notice.txt", "text/plain", new TextEncoder().encode("中文制度\n第一条"), "TEXT"],
  ])("accepts %s only when extension, MIME and signature agree", (fileName, mimeType, bytes, strategy) => {
    expect(validatePolicyFile({ fileName, mimeType, bytes })).toMatchObject({ strategy });
  });

  it.each([
    ["fake.pdf", "application/pdf", new TextEncoder().encode("not pdf")],
    ["fake.docx", "text/plain", new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
    ["fake.png", "image/jpeg", png],
    ["binary.txt", "text/plain", new Uint8Array([0, 1, 2, 3])],
    ["script.html", "text/html", new TextEncoder().encode("<script />")],
  ])("rejects spoofed or unsupported file %s", (fileName, mimeType, bytes) => {
    expect(() => validatePolicyFile({ fileName, mimeType, bytes })).toThrow(PolicyFileError);
  });
});
