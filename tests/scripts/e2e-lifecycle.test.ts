import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCleanupErrorReporter,
  createIdempotentCleanup,
  installTerminationHandlers,
  runAbortableStartup,
  runWithCleanup,
  snapshotTrackedFiles,
} from "../../scripts/e2e-lifecycle.mjs";

const temporaryRoots: string[] = [];

async function trackedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cohort-harbor-e2e-lifecycle-"));
  temporaryRoots.push(root);
  const files = [path.join(root, "next-env.d.ts"), path.join(root, "tsconfig.json")];
  await Promise.all(files.map((file, index) => writeFile(file, `original-${index}`, "utf8")));
  return { files, restore: snapshotTrackedFiles(files) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("E2E lifecycle cleanup", () => {
  it("reports shared aggregate leaves once while preserving distinct errors with the same message", async () => {
    const sharedFailure = new Error("stop server failed");
    const distinctFailure = new Error("stop server failed");
    const resourceCleanup = createIdempotentCleanup([
      async () => { throw sharedFailure; },
    ]);
    const globalCleanup = createIdempotentCleanup([
      resourceCleanup,
      async () => { throw distinctFailure; },
    ]);
    const reported: unknown[] = [];
    const reportCleanupError = createCleanupErrorReporter((error) => reported.push(error));

    await globalCleanup().catch(reportCleanupError);
    await resourceCleanup().catch(reportCleanupError);

    expect(reported).toEqual([sharedFailure, distinctFailure]);
  });

  it("reports leafless aggregate cycles once without adding noise when a real leaf is reachable", () => {
    const selfCycle = new AggregateError([], "self cycle");
    selfCycle.errors.push(selfCycle);
    const mutualLeft = new AggregateError([], "mutual left");
    const mutualRight = new AggregateError([], "mutual right");
    mutualLeft.errors.push(mutualRight);
    mutualRight.errors.push(mutualLeft);
    const reachableLeaf = new Error("reachable cleanup failure");
    const cycleWithLeaf = new AggregateError([], "cycle with leaf");
    cycleWithLeaf.errors.push(cycleWithLeaf, reachableLeaf);
    const lateLeaf = new Error("leaf after mutual cycle");
    const lateLeafLeft = new AggregateError([], "late-leaf left");
    const lateLeafRight = new AggregateError([], "late-leaf right");
    lateLeafLeft.errors.push(lateLeafRight, lateLeaf);
    lateLeafRight.errors.push(lateLeafLeft);
    const reported: unknown[] = [];
    const reportCleanupError = createCleanupErrorReporter((error) => reported.push(error));

    reportCleanupError(selfCycle);
    reportCleanupError(mutualLeft);
    reportCleanupError(cycleWithLeaf);
    reportCleanupError(lateLeafLeft);

    expect(reported).toHaveLength(4);
    expect(reported[0]).toBe(selfCycle);
    expect([mutualLeft, mutualRight]).toContain(reported[1]);
    expect(reported[2]).toBe(reachableLeaf);
    expect(reported[3]).toBe(lateLeaf);
  });

  it("restores tracked configuration exactly once after a normal run", async () => {
    const { files, restore } = await trackedFixture();
    const stopRunner = vi.fn(async () => undefined);
    const stopServer = vi.fn(async () => undefined);
    const closeSmtp = vi.fn(async () => undefined);
    const cleanup = createIdempotentCleanup([stopRunner, stopServer, closeSmtp, restore]);

    const exitCode = await runWithCleanup({
      run: async () => {
        await Promise.all(files.map((file) => writeFile(file, "generated-noise", "utf8")));
        return 0;
      },
      cleanup,
      onRunError: vi.fn(),
      onCleanupError: vi.fn(),
    });
    await cleanup();

    expect(exitCode).toBe(0);
    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(closeSmtp).toHaveBeenCalledTimes(1);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
  });

  it("restores tracked configuration when the Playwright runner exits unsuccessfully", async () => {
    const { files, restore } = await trackedFixture();
    const cleanup = createIdempotentCleanup([restore]);

    const exitCode = await runWithCleanup({
      run: async () => {
        await Promise.all(files.map((file) => writeFile(file, "failed-run-noise", "utf8")));
        return 1;
      },
      cleanup,
      onRunError: vi.fn(),
      onCleanupError: vi.fn(),
    });

    expect(exitCode).toBe(1);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
  });

  it("restores tracked configuration even when runner cleanup fails", async () => {
    const { files, restore } = await trackedFixture();
    await Promise.all(files.map((file) => writeFile(file, "runner-failure-noise", "utf8")));
    const cleanup = createIdempotentCleanup([
      async () => { throw new Error("runner cleanup failed"); },
      restore,
    ]);

    await expect(cleanup()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "runner cleanup failed" })] });
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("awaits full cleanup on %s before assigning exit code %i", async (signal, exitCode) => {
    const { files, restore } = await trackedFixture();
    await Promise.all(files.map((file) => writeFile(file, "signal-noise", "utf8")));
    const order: string[] = [];
    const processLike = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
    const cleanup = createIdempotentCleanup([
      async () => { order.push("runner"); },
      async () => { order.push("server"); },
      async () => { order.push("smtp"); },
      async () => { restore(); order.push("restore"); },
    ]);
    const errors: unknown[] = [];
    const termination = installTerminationHandlers({ processLike, cleanup, onError: (error) => errors.push(error) });

    processLike.emit(signal);
    expect(processLike.exitCode).toBeUndefined();
    await termination.wait();

    expect(order).toEqual(["runner", "server", "smtp", "restore"]);
    expect(processLike.exitCode).toBe(exitCode);
    expect(errors).toEqual([]);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
    termination.dispose();
  });

  it("disposes an SMTP server that finishes starting after termination and never starts the runner", async () => {
    const { files, restore } = await trackedFixture();
    await Promise.all(files.map((file) => writeFile(file, "startup-noise", "utf8")));
    const processLike = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
    const cleanup = createIdempotentCleanup([restore]);
    const termination = installTerminationHandlers({ processLike, cleanup, onError: vi.fn() });
    let finishSmtpStartup!: () => void;
    let smtpListening = false;
    let runnerStarted = false;

    const smtpStage = runAbortableStartup({
      start: () => new Promise<void>((resolve) => {
        finishSmtpStartup = () => { smtpListening = true; resolve(); };
      }),
      dispose: async () => { smtpListening = false; },
      isTerminated: () => termination.exitCode !== null,
      terminationSignal: termination.signal,
      onDisposeError: vi.fn(),
    });
    processLike.emit("SIGTERM");
    await termination.wait();
    finishSmtpStartup();
    if (await smtpStage) runnerStarted = true;

    await vi.waitFor(() => expect(smtpListening).toBe(false));
    expect(smtpListening).toBe(false);
    expect(runnerStarted).toBe(false);
    expect(processLike.exitCode).toBe(143);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
    termination.dispose();
  });

  it("settles promptly when termination is requested while startup remains pending", async () => {
    const controller = new AbortController();
    let finishStartup!: () => void;
    const dispose = vi.fn(async () => undefined);
    const startupStage = runAbortableStartup({
      start: () => new Promise<void>((resolve) => { finishStartup = resolve; }),
      dispose,
      isTerminated: () => controller.signal.aborted,
      terminationSignal: controller.signal,
      onDisposeError: vi.fn(),
    });

    controller.abort();
    const promptResult = await Promise.race([
      startupStage,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    finishStartup();

    expect(promptResult).toBe(false);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it("reports a late startup disposal failure without changing signal exit semantics or skipping cleanup", async () => {
    const { files, restore } = await trackedFixture();
    await Promise.all(files.map((file) => writeFile(file, "late-dispose-noise", "utf8")));
    const processLike = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
    const remainingCleanup = vi.fn(async () => undefined);
    const cleanup = createIdempotentCleanup([remainingCleanup, restore]);
    const terminationErrors: unknown[] = [];
    const termination = installTerminationHandlers({ processLike, cleanup, onError: (error) => terminationErrors.push(error) });
    let finishStartup!: () => void;
    const lateDisposeError = new Error("late SMTP disposal failed");

    const smtpStage = runAbortableStartup({
      start: () => new Promise<void>((resolve) => { finishStartup = resolve; }),
      dispose: async () => { throw lateDisposeError; },
      isTerminated: () => termination.exitCode !== null,
      terminationSignal: termination.signal,
      onDisposeError: (error) => terminationErrors.push(error),
    });
    processLike.emit("SIGTERM");
    await termination.wait();
    finishStartup();

    await expect(smtpStage).resolves.toBe(false);
    await vi.waitFor(() => expect(terminationErrors).toEqual([lateDisposeError]));
    expect(terminationErrors).toEqual([lateDisposeError]);
    expect(remainingCleanup).toHaveBeenCalledTimes(1);
    expect(processLike.exitCode).toBe(143);
    await expect(Promise.all(files.map((file) => readFile(file, "utf8"))))
      .resolves.toEqual(["original-0", "original-1"]);
    termination.dispose();
  });
});
