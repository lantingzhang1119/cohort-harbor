import yauzl, { type Entry, type ZipFile } from "yauzl";

import { QuestionBankSource } from "@/generated/prisma/enums";
import { recognizeStructure } from "@/features/question-banks/import/parsers/structure-recognizer";
import type { ParseResult } from "@/features/question-banks/import/import-types";

const DOCUMENT_XML = "word/document.xml";
const MAX_DOCUMENT_XML_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("DOCX_OPEN_FAILED"));
        else resolve(zip);
      },
    );
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("DOCX_ENTRY_OPEN_FAILED"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_DOCUMENT_XML_BYTES) {
          stream.destroy(new Error("DOCX_DOCUMENT_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readDocumentXml(bytes: Uint8Array): Promise<string | null> {
  const zip = await openZip(bytes);
  try {
    return await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      let entryCount = 0;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => finish(null));
      zip.on("entry", async (entry: Entry) => {
        try {
          entryCount += 1;
          if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("DOCX_TOO_MANY_ENTRIES");
          if (entry.fileName !== DOCUMENT_XML) {
            zip.readEntry();
            return;
          }
          const content = await readEntry(zip, entry);
          finish(content.toString("utf8"));
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      if (entity === "&lt;") return "<";
      if (entity === "&gt;") return ">";
      if (entity === "&amp;") return "&";
      if (entity === "&quot;") return '"';
      if (entity === "&apos;") return "'";
      const hexadecimal = entity.startsWith("&#x") || entity.startsWith("&#X");
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

function extractDocxParagraphs(documentXml: string): string[] {
  const paragraphs: string[] = [];
  const paragraphRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const textRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let numberedSequence = 0;
  for (const match of documentXml.matchAll(paragraphRegex)) {
    const chunk = match[0];
    const texts = [...chunk.matchAll(textRegex)].map((textMatch) => decodeXmlText(textMatch[1]!));
    let line = texts.join("").replace(/\u00a0/g, " ").trim();
    if (!line) continue;
    if (/<w:numPr(?:\s|>)/.test(chunk) && !/^(?:【?题号】?|Q)?\s*\d+[.、)\s]/i.test(line)) {
      numberedSequence += 1;
      line = `${numberedSequence}. ${line}`;
    }
    paragraphs.push(line);
  }
  return paragraphs;
}

function looksLikeStandardTemplate(lines: string[]): boolean {
  const joined = lines.join("\n");
  return joined.includes("【题号】") && joined.includes("【题型】") && joined.includes("【题干】");
}

export async function parseWordQuestionBank(bytes: Uint8Array): Promise<ParseResult> {
  const documentXml = await readDocumentXml(bytes);
  if (!documentXml) {
    return {
      bankName: "Word 导入题库",
      mode: "BEST_EFFORT",
      source: QuestionBankSource.WORD,
      questions: [],
      sourceFragments: [],
      warnings: [{ code: "INVALID_DOCX", message: "无法读取 Word 文档正文" }],
    };
  }

  const lines = extractDocxParagraphs(documentXml);
  const template = looksLikeStandardTemplate(lines);
  const recognized = recognizeStructure({
    lines,
    mode: template ? "TEMPLATE" : "BEST_EFFORT",
    bankName: "Word 导入题库",
  });
  const questions = template
    ? recognized.questions
    : recognized.questions.map((question) => ({
        ...question,
        needsReview: true,
        reviewReasons: question.reviewReasons.includes("非标准模板尽力识别")
          ? question.reviewReasons
          : [...question.reviewReasons, "非标准模板尽力识别"],
      }));

  return {
    bankName: recognized.bankName,
    mode: template ? "TEMPLATE" : "BEST_EFFORT",
    source: QuestionBankSource.WORD,
    questions,
    sourceFragments: recognized.sourceFragments,
    warnings: template
      ? recognized.warnings
      : [{ code: "BEST_EFFORT", message: "非标准 Word 模板，已尽力识别，需人工确认" }, ...recognized.warnings],
    extraction: { format: template ? "docx-template" : "docx-best-effort" },
  };
}
