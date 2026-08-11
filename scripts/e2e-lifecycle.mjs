import { readFileSync, writeFileSync } from "node:fs";

export function snapshotTrackedFiles(filePaths) {
  const snapshots = filePaths.map((filePath) => ({
    filePath,
    contents: readFileSync(filePath),
  }));
  return () => {
    for (const snapshot of snapshots) writeFileSync(snapshot.filePath, snapshot.contents);
  };
}

export function createIdempotentCleanup(steps) {
  let cleanupPromise;
  return function cleanup() {
    cleanupPromise ??= (async () => {
      const errors = [];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "E2E cleanup failed");
    })();
    return cleanupPromise;
  };
}

export function createCleanupErrorReporter(report) {
  const reportedLeaves = new Set();
  return function reportCleanupError(error) {
    const visitedAggregates = new Set();
    const leaves = [];
    let representativeAggregate;
    const reportLeaf = (leaf) => {
      if (!reportedLeaves.has(leaf)) {
        reportedLeaves.add(leaf);
        report(leaf);
      }
    };
    const visit = (candidate) => {
      if (!(candidate instanceof AggregateError) || candidate.errors.length === 0) {
        leaves.push(candidate);
        return;
      }
      representativeAggregate ??= candidate;
      if (visitedAggregates.has(candidate)) return;
      visitedAggregates.add(candidate);
      for (const nestedError of candidate.errors) visit(nestedError);
    };
    visit(error);
    if (leaves.length === 0) reportLeaf(representativeAggregate ?? error);
    else for (const leaf of leaves) reportLeaf(leaf);
  };
}

export async function runWithCleanup({ run, cleanup, onRunError, onCleanupError }) {
  let exitCode = 1;
  try {
    exitCode = await run();
  } catch (error) {
    onRunError(error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      onCleanupError(error);
      exitCode = 1;
    }
  }
  return exitCode;
}

export async function runAbortableStartup({ start, dispose, isTerminated, terminationSignal, onDisposeError }) {
  if (isTerminated() || terminationSignal.aborted) return false;
  const startup = Promise.resolve().then(start);
  let handleAbort;
  const terminationRequested = new Promise((resolve) => {
    handleAbort = () => resolve("terminated");
    terminationSignal.addEventListener("abort", handleAbort, { once: true });
    if (terminationSignal.aborted) handleAbort();
  });
  let outcome;
  try {
    outcome = await Promise.race([
      startup.then(() => "started"),
      terminationRequested,
    ]);
  } finally {
    terminationSignal.removeEventListener("abort", handleAbort);
  }
  if (outcome === "terminated") {
    void startup.then(async () => {
      try {
        await dispose();
      } catch (error) {
        onDisposeError(error);
      }
    }, () => undefined);
    return false;
  }
  if (!isTerminated() && !terminationSignal.aborted) return true;
  try {
    await dispose();
  } catch (error) {
    onDisposeError(error);
  }
  return false;
}

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

export function installTerminationHandlers({ processLike, cleanup, onError }) {
  let exitCode = null;
  let terminationPromise = null;
  const controller = new AbortController();
  const handlers = Object.fromEntries(Object.entries(signalExitCodes).map(([signal, code]) => [signal, () => {
    exitCode ??= code;
    if (!controller.signal.aborted) controller.abort(signal);
    terminationPromise ??= Promise.resolve()
      .then(cleanup)
      .catch((error) => { onError(error); })
      .finally(() => { processLike.exitCode = exitCode; });
  }]));
  for (const [signal, handler] of Object.entries(handlers)) processLike.once(signal, handler);
  return {
    get exitCode() { return exitCode; },
    signal: controller.signal,
    wait: () => terminationPromise ?? Promise.resolve(),
    dispose() {
      for (const [signal, handler] of Object.entries(handlers)) processLike.off(signal, handler);
    },
  };
}
