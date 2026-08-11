import { deflateRawSync } from "node:zlib";

import * as XLSX from "xlsx";

const EXCEL_HEADERS = ["题号", "题型", "题干", "选项A", "选项B", "选项C", "选项D", "答案", "分值"];

const EXCEL_SAMPLE_ROWS: unknown[][] = [
  [1, "单选", "一加一等于几？", "1", "2", "3", "4", "B", 40],
  [2, "多选", "下列哪些是偶数？", "1", "2", "3", "4", "B;D", 30],
  [3, "填空", "中华人民共和国的首都是____。", "", "", "", "", "北京|Beijing", 30],
];

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
    nameBytes.forEach((value, index) => {
      local[30 + index] = value;
    });
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
    nameBytes.forEach((value, index) => {
      central[46 + index] = value;
    });
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
  const out = new Uint8Array(offset + centralSize + end.byteLength);
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

export function buildExcelTemplateBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...EXCEL_SAMPLE_ROWS]);
  XLSX.utils.book_append_sheet(workbook, sheet, "题库");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export function buildWordTemplateBytes(): Uint8Array {
  const lines = [
    "题库名称：标准模板样卷",
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
    ${lines.map(paragraph).join("\n    ")}
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

export function getTemplateInstructionsMarkdown(): string {
  return `# 题库标准导入模板填写说明

## 支持格式
- Word（.docx，推荐标准标记模板）
- Excel（.xlsx 标准列模板）
- PDF（文字型尽力识别；扫描型走本地 OCR）

## Excel 标准列
| 题号 | 题型 | 题干 | 选项A | 选项B | 选项C | 选项D | 答案 | 分值 |

### 题型取值
- 单选 / 多选 / 填空

### 答案填写
- 单选：填写选项字母，如 \`B\`
- 多选：多个字母用 \`;\` 或 \`,\` 分隔，如 \`B;D\`
- 填空：多个可接受答案用 \`|\` 或 \`;\` 分隔，如 \`北京|Beijing\`

### 分值
- 必须为正整数；导入后仍可在线调整。启用题库时启用题目总分需为 100。

## Word 标准标记
\`\`\`
题库名称：示例试卷
【题号】1
【题型】单选
【题干】……
【选项】
A. ……
B. ……
【答案】B
【分值】10
\`\`\`

## 任意格式
非标准模板会尽力识别，不确定项会标记为“需要复核”，管理员必须预览修正后才能确认写入正式题库。

## 安全说明
- 原文件仅保存在私有存储
- 扫描 PDF 使用本机 OCR（tesseract.js + 本地 chi_sim/eng），禁止云 OCR
`;
}
