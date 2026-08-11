export type CleanupStep = () => void | Promise<void>;

export function snapshotTrackedFiles(filePaths: string[]): () => void;

export function createIdempotentCleanup(steps: CleanupStep[]): () => Promise<void>;

export function createCleanupErrorReporter(
  report: (error: unknown) => void,
): (error: unknown) => void;

export function runWithCleanup(options: {
  run: () => Promise<number>;
  cleanup: () => Promise<void>;
  onRunError: (error: unknown) => void;
  onCleanupError: (error: unknown) => void;
}): Promise<number>;

export function runAbortableStartup(options: {
  start: () => void | Promise<void>;
  dispose: () => void | Promise<void>;
  isTerminated: () => boolean;
  terminationSignal: AbortSignal;
  onDisposeError: (error: unknown) => void;
}): Promise<boolean>;

export function installTerminationHandlers(options: {
  processLike: {
    exitCode?: number;
    once(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
    off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  };
  cleanup: () => Promise<void>;
  onError: (error: unknown) => void;
}): {
  readonly exitCode: number | null;
  readonly signal: AbortSignal;
  wait(): Promise<void>;
  dispose(): void;
};
