import { access, readdir } from "node:fs/promises";
import path from "node:path";

import { createWorker, type Worker } from "tesseract.js";

const DEFAULT_LANGUAGES = ["chi_sim", "eng"] as const;
const DEFAULT_OCR_TIMEOUT_MS = 90_000;

function candidateLangPaths() {
  return [
    process.env.TESSDATA_PREFIX,
    path.resolve(process.cwd(), "vendor/tessdata"),
    path.resolve(process.cwd(), "src/features/question-banks/import/ocr/tessdata"),
  ].filter((value): value is string => Boolean(value));
}

export async function resolveTessdataPath(): Promise<string> {
  for (const candidate of candidateLangPaths()) {
    const resolved = path.resolve(candidate);
    const hasChi = await access(path.join(resolved, "chi_sim.traineddata")).then(() => true).catch(() => false);
    const hasEng = await access(path.join(resolved, "eng.traineddata")).then(() => true).catch(() => false);
    if (hasChi && hasEng) return resolved;
  }
  throw new Error("本地 OCR 语言包缺失：需要 vendor/tessdata 下的 chi_sim.traineddata 与 eng.traineddata");
}

export async function loadOcrLanguages(languages: string[] = [...DEFAULT_LANGUAGES]) {
  const langPath = await resolveTessdataPath();
  const files = await readdir(langPath);
  for (const language of languages) {
    if (!/^[a-z][a-z0-9_]{1,31}$/i.test(language)) {
      throw new Error(`OCR 语言标识无效: ${language}`);
    }
    if (!files.includes(`${language}.traineddata`)) {
      throw new Error(`本地 OCR 语言数据不可用: ${language}`);
    }
  }
  return {
    languages,
    langPath,
    source: "local" as const,
  };
}

let sharedWorker: Worker | null = null;
let sharedWorkerKey: string | null = null;
let recognitionTail: Promise<void> = Promise.resolve();

function serializeRecognition<T>(task: () => Promise<T>): Promise<T> {
  const result = recognitionTail.then(task, task);
  recognitionTail = result.then(() => undefined, () => undefined);
  return result;
}

async function getWorker(languages: string[]) {
  const loaded = await loadOcrLanguages(languages);
  const key = `${loaded.langPath}::${loaded.languages.join("+")}`;
  if (sharedWorker && sharedWorkerKey === key) return { worker: sharedWorker, loaded };

  if (sharedWorker) {
    await sharedWorker.terminate().catch(() => undefined);
    sharedWorker = null;
    sharedWorkerKey = null;
  }

  // Absolute local langPath only — never remote/CDN tessdata.
  const worker = await createWorker(loaded.languages.join("+"), 1, {
    langPath: loaded.langPath,
    cachePath: loaded.langPath,
    gzip: false,
  });
  sharedWorker = worker;
  sharedWorkerKey = key;
  return { worker, loaded };
}

export async function runLocalOcr(
  imagePath: string,
  options: { languages?: string[]; timeoutMs?: number } = {},
): Promise<{ text: string; confidence: number; languages: string[]; langPath: string }> {
  return serializeRecognition(async () => {
    const languages = options.languages ?? [...DEFAULT_LANGUAGES];
    const timeoutMs = options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
      throw new RangeError("OCR timeoutMs must be between 1000 and 600000");
    }
    const { worker, loaded } = await getWorker(languages);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        worker.recognize(imagePath),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("OCR_TIMEOUT")), timeoutMs);
        }),
      ]);
      return {
        text: result.data.text ?? "",
        confidence: Number(result.data.confidence ?? 0),
        languages: loaded.languages,
        langPath: loaded.langPath,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "OCR_TIMEOUT") {
        if (sharedWorker === worker) {
          sharedWorker = null;
          sharedWorkerKey = null;
        }
        await worker.terminate().catch(() => undefined);
        throw new Error(`本地 OCR 处理超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

export async function disposeOcrWorker() {
  await recognitionTail;
  if (!sharedWorker) return;
  await sharedWorker.terminate().catch(() => undefined);
  sharedWorker = null;
  sharedWorkerKey = null;
}
