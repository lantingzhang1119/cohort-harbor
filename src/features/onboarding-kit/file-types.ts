export type UploadFileLike = {
  fileName: string;
  mimeType: string;
  size: number;
  stream(): ReadableStream<Uint8Array>;
};

export type UploadLimits = {
  maxBytes: number;
  maxArchiveEntries?: number;
  maxArchiveEntryNameBytes?: number;
  maxArchiveUncompressedBytes?: number;
  maxArchiveCompressionRatio?: number;
  tempRoot?: string;
};

export type ValidatedUpload = {
  originalName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  stagedPath: string;
  cleanup(): Promise<void>;
};
