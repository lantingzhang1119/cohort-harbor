export class PortalRequestBodyError extends Error {
  constructor(
    public readonly code: "BODY_TOO_LARGE" | "INVALID_JSON",
    message: string,
  ) {
    super(message);
    this.name = "PortalRequestBodyError";
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  options: { cancelOnLimit?: boolean } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (!request.body) {
    throw new PortalRequestBodyError("INVALID_JSON", "请求正文必须是有效的 JSON");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        if (options.cancelOnLimit !== false) {
          try {
            await reader.cancel("portal request body exceeded byte limit");
          } catch {
            // The size violation remains authoritative even if the producer's
            // cancellation hook is faulty.
          }
        }
        throw new PortalRequestBodyError("BODY_TOO_LARGE", "门户请求正文超过允许大小");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(
  request: Request,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const bytes = await readBoundedBody(request, maxBytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new PortalRequestBodyError("INVALID_JSON", "请求正文必须是有效的 JSON");
  }
}
