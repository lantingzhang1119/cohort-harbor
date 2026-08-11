import { describe, expect, it, vi } from "vitest";

import { createPrivateFileResponse } from "@/lib/storage/private-file-response";

function fakeHandle(chunks: Array<Uint8Array | Error>) {
  let index = 0;
  return {
    read: vi.fn(async (buffer: Uint8Array) => {
      const item = chunks[index++];
      if (item instanceof Error) throw item;
      if (!item) return { bytesRead: 0, buffer };
      buffer.set(item);
      return { bytesRead: item.byteLength, buffer };
    }),
    readFile: vi.fn(),
    stat: vi.fn(async () => ({ isFile: () => true, size: chunks.reduce((total, item) => total + (item instanceof Error ? 1 : item.byteLength), 0) })),
    close: vi.fn(async () => undefined),
  };
}

describe("private file streaming response", () => {
  it("does not eagerly close or call readFile and closes exactly once after consumption", async () => {
    const handle = fakeHandle([Buffer.from("streamed")]);
    const response = await createPrivateFileResponse("/private/test.bin", {
      contentType: "application/octet-stream",
      size: 8,
      openFile: vi.fn(async () => handle),
    });

    expect(handle.close).not.toHaveBeenCalled();
    expect(handle.readFile).not.toHaveBeenCalled();
    expect(await response.text()).toBe("streamed");
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.readFile).not.toHaveBeenCalled();
  });

  it("closes exactly once when the consumer cancels", async () => {
    const handle = fakeHandle([Buffer.from("first"), Buffer.from("second")]);
    const response = await createPrivateFileResponse("/private/test.bin", {
      contentType: "application/octet-stream",
      chunkSize: 5,
      size: 11,
      openFile: vi.fn(async () => handle),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("closes exactly once and errors the stream when a read fails", async () => {
    const handle = fakeHandle([new Error("disk read failed")]);
    const response = await createPrivateFileResponse("/private/test.bin", {
      contentType: "application/octet-stream",
      size: 1,
      openFile: vi.fn(async () => handle),
    });
    await expect(response.arrayBuffer()).rejects.toThrow("disk read failed");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("runs final cleanup exactly once after success, cancellation or read failure", async () => {
    for (const scenario of ["success", "cancel", "failure"] as const) {
      const handle = fakeHandle(scenario === "failure" ? [new Error("read failed")] : [Buffer.from("x")]);
      const onClose = vi.fn(async () => undefined);
      const response = await createPrivateFileResponse("/private/test.bin", {
        contentType: "application/octet-stream", size: 1, openFile: vi.fn(async () => handle), onClose,
      });
      if (scenario === "success") await response.arrayBuffer();
      else if (scenario === "cancel") await response.body!.cancel();
      else await expect(response.arrayBuffer()).rejects.toThrow("read failed");
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });
});
