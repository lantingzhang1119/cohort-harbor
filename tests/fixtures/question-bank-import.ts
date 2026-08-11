import { deflateRawSync } from "node:zlib";

import * as XLSX from "xlsx";

/** Generic educational fixtures — no company-specific content. */

export const STANDARD_EXCEL_HEADERS = [
  "题号",
  "题型",
  "题干",
  "选项A",
  "选项B",
  "选项C",
  "选项D",
  "答案",
  "分值",
] as const;

export const STANDARD_MIXED_ROWS: unknown[][] = [
  [1, "单选", "一加一等于几？", "1", "2", "3", "4", "B", 40],
  [2, "多选", "下列哪些是偶数？", "1", "2", "3", "4", "B;D", 30],
  [3, "填空", "中华人民共和国的首都是____。", "", "", "", "", "北京|Beijing", 30],
];

export function createStandardExcelWorkbook(options?: {
  rows?: unknown[][];
  headers?: string[];
  sheetName?: string;
  bookType?: "xlsx" | "xls";
}): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const headers = options?.headers ?? [...STANDARD_EXCEL_HEADERS];
  const rows = options?.rows ?? STANDARD_MIXED_ROWS;
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, options?.sheetName ?? "题库");
  const bookType = options?.bookType ?? "xlsx";
  return new Uint8Array(
    XLSX.write(workbook, { type: "array", bookType }) as ArrayBuffer,
  );
}

export function createMissingAnswerExcelWorkbook(): Uint8Array {
  return createStandardExcelWorkbook({
    rows: [[1, "单选", "缺少答案的题目", "是", "否", "", "", "", 100]],
  });
}

/** Minimal OOXML package writer for standard Word template fixtures. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = deflateRawSync(entry.data);
    const useStore = compressed.byteLength >= entry.data.byteLength;
    const payload = useStore ? entry.data : compressed;
    const method = useStore ? 0 : 8;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.forEach((value, index) => local[30 + index] = value);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.forEach((value, index) => central[46 + index] = value);

    localParts.push(new Uint8Array(local), payload);
    centralParts.push(new Uint8Array(central));
    offset += local.byteLength + payload.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const total = offset + centralSize + end.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  out.set(new Uint8Array(end), cursor);
  return out;
}

function paragraph(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}

export function createStandardWordDocument(lines?: string[]): Uint8Array {
  const bodyLines = lines ?? [
    "题库名称：通用知识样卷",
    "【题号】1",
    "【题型】单选",
    "【题干】一加一等于几？",
    "【选项】",
    "A. 1",
    "B. 2",
    "C. 3",
    "D. 4",
    "【答案】B",
    "【分值】40",
    "【题号】2",
    "【题型】多选",
    "【题干】下列哪些是偶数？",
    "【选项】",
    "A. 1",
    "B. 2",
    "C. 3",
    "D. 4",
    "【答案】B;D",
    "【分值】30",
    "【题号】3",
    "【题型】填空",
    "【题干】中华人民共和国的首都是____。",
    "【答案】北京|Beijing",
    "【分值】30",
  ];

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyLines.map(paragraph).join("\n    ")}
    <w:sectPr/>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return zipStore([
    { name: "[Content_Types].xml", data: new TextEncoder().encode(contentTypes) },
    { name: "_rels/.rels", data: new TextEncoder().encode(rels) },
    { name: "word/document.xml", data: new TextEncoder().encode(documentXml) },
    { name: "word/_rels/document.xml.rels", data: new TextEncoder().encode(documentRels) },
  ]);
}

export function createBrokenNumberWordDocument(): Uint8Array {
  return createStandardWordDocument([
    "题库名称：题号断裂样卷",
    "【题号】1",
    "【题型】单选",
    "【题干】第一题",
    "A. 甲",
    "B. 乙",
    "【答案】A",
    "【分值】50",
    "【题号】3",
    "【题型】单选",
    "【题干】第三题，跳过了第二题",
    "A. 甲",
    "B. 乙",
    "【答案】B",
    "【分值】50",
  ]);
}

/** Minimal single-page text PDF with Latin + ASCII for pdfjs extraction tests. */
export function createTextPdf(lines: string[]): Uint8Array {
  const textOperators = lines
    .map((line, index) => {
      const escaped = line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
      const y = 750 - index * 24;
      return `BT /F1 12 Tf 50 ${y} Td (${escaped}) Tj ET`;
    })
    .join("\n");

  const stream = `${textOperators}\n`;
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${Buffer.byteLength(stream, "utf8")} >>stream\n${stream}endstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function createStandardTextPdf(): Uint8Array {
  return createTextPdf([
    "Question Bank Sample",
    "1. [SINGLE] One plus one equals?",
    "A. 1",
    "B. 2",
    "C. 3",
    "D. 4",
    "Answer: B",
    "Score: 100",
  ]);
}

/** Tiny valid PNG (1x1 white) used only as a non-PDF spoof fixture. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);
