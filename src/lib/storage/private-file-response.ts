import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

type ReadResult = { bytesRead: number; buffer: Uint8Array };
type PrivateFileHandle = {
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<ReadResult>;
  stat(): Promise<{ isFile(): boolean; size: number }>;
  close(): Promise<void>;
};

export type PrivateFileResponseOptions = {
  contentType: string;
  headers?: HeadersInit;
  status?: number;
  start?: number;
  end?: number;
  chunkSize?: number;
  size?: number;
  openFile?: (path: string, flags: number) => Promise<PrivateFileHandle>;
  onClose?: () => void | Promise<void>;
};

export async function createPrivateFileResponse(
  filePath: string,
  options: PrivateFileResponseOptions,
): Promise<Response> {
  const knownSize = options.size ?? (await stat(filePath)).size;
  let handle: PrivateFileHandle | null = null;
  let opening: Promise<PrivateFileHandle> | null = null;
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    const opened = handle ?? (opening ? await opening.catch(() => null) : null);
    await opened?.close().catch(() => undefined);
    await Promise.resolve(options.onClose?.()).catch(() => undefined);
  };

  const ensureHandle = async () => {
    if (closed) throw new Error("Private file response is already closed");
    if (handle) return handle;
    opening ??= (options.openFile ?? open)(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    handle = await opening;
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size < knownSize) {
      await closeOnce();
      throw new Error("Private asset changed before it could be streamed");
    }
    return handle;
  };

  try {
    const start = options.start ?? 0;
    const end = options.end ?? knownSize - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= knownSize
    ) {
      await closeOnce();
      throw new RangeError("Invalid private file response range");
    }
    const chunkSize = Math.max(1, Math.min(options.chunkSize ?? 64 * 1024, 1024 * 1024));
    let position = start;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (position > end) {
          await closeOnce();
          controller.close();
          return;
        }
        try {
          const currentHandle = await ensureHandle();
          const requested = Math.min(chunkSize, end - position + 1);
          const buffer = new Uint8Array(requested);
          const { bytesRead } = await currentHandle.read(buffer, 0, requested, position);
          if (bytesRead === 0) {
            await closeOnce();
            controller.error(new Error("Private asset ended before the authorized range"));
            return;
          }
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          await closeOnce();
          controller.error(error);
        }
      },
      async cancel() {
        await closeOnce();
      },
    }, { highWaterMark: 0 });
    const headers = new Headers(options.headers);
    headers.set("content-type", options.contentType);
    headers.set("content-length", String(end - start + 1));
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(stream, { status: options.status ?? 200, headers });
  } catch (error) {
    await closeOnce();
    throw error;
  }
}
