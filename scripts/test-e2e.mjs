import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeE2eArgs } from "./e2e-args.mjs";
import { createE2eEnvironment } from "./e2e-environment.mjs";
import {
  createCleanupErrorReporter,
  createIdempotentCleanup,
  installTerminationHandlers,
  runAbortableStartup,
  runWithCleanup,
  snapshotTrackedFiles,
} from "./e2e-lifecycle.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eDistDir = ".next-e2e";
const restoreGeneratedTypeConfigs = snapshotTrackedFiles(
  ["next-env.d.ts", "tsconfig.json"].map((relativePath) => path.join(projectRoot, relativePath)),
);
const environment = createE2eEnvironment(process.env, e2eDistDir);

rmSync(path.join(projectRoot, e2eDistDir), { recursive: true, force: true });

let server;
let fakeSmtp;
let runner;
let runnerCompletion;
let setupRunner;
let closeFakeSmtpResource;
let stopServerResource;
let stopRunnerResource;
const fakeSmtpSockets = new Set();

async function startFakeSmtp() {
  fakeSmtp = createServer((socket) => {
    fakeSmtpSockets.add(socket);
    socket.once("close", () => fakeSmtpSockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 onboarding-e2e.local ESMTP\r\n");
    let buffer = "";
    let authStep = 0;
    let readingData = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const boundary = buffer.indexOf("\r\n");
        if (boundary < 0) break;
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (readingData) {
          if (line === ".") { readingData = false; socket.write("250 2.0.0 queued\r\n"); }
          continue;
        }
        if (authStep === 1) { authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); continue; }
        if (authStep === 2) { authStep = 0; socket.write("235 2.7.0 authenticated\r\n"); continue; }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-onboarding-e2e.local\r\n250-AUTH PLAIN LOGIN\r\n250 PIPELINING\r\n");
        else if (command.startsWith("AUTH PLAIN")) socket.write("235 2.7.0 authenticated\r\n");
        else if (command === "AUTH LOGIN") { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (command.startsWith("MAIL FROM") || command.startsWith("RCPT TO") || command === "RSET" || command === "NOOP") socket.write("250 2.0.0 ok\r\n");
        else if (command === "DATA") { readingData = true; socket.write("354 end with <CRLF>.<CRLF>\r\n"); }
        else if (command === "QUIT") { socket.end("221 2.0.0 bye\r\n"); }
        else socket.write("250 2.0.0 ok\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    fakeSmtp.once("error", reject);
    fakeSmtp.listen(3125, "127.0.0.1", resolve);
  });
  const smtpServer = fakeSmtp;
  closeFakeSmtpResource = createIdempotentCleanup([async () => {
    for (const socket of fakeSmtpSockets) socket.destroy();
    if (!smtpServer.listening) return;
    await new Promise((resolve, reject) => smtpServer.close((error) => error ? reject(error) : resolve()));
  }]);
}

function startNextServer() {
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3100"],
    { cwd: projectRoot, env: environment, stdio: "ignore", windowsHide: true },
  );
  const child = server;
  stopServerResource = createIdempotentCleanup([() => stopChildProcess(child)]);
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", () => resolve(true)));
  if (child.pid && process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }
  const stopped = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function closeFakeSmtp() {
  await closeFakeSmtpResource?.();
}

async function stopNextServer() {
  await stopServerResource?.();
}

async function stopPlaywrightRunner() {
  await stopRunnerResource?.();
}

async function prepareE2eDatabase(signal) {
  setupRunner = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "e2e/global-setup.ts"],
    { cwd: projectRoot, env: environment, stdio: "inherit", windowsHide: true },
  );
  const child = setupRunner;
  const abort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`E2E 数据初始化失败，退出码：${exitCode}`);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

const cleanup = createIdempotentCleanup([
  stopPlaywrightRunner,
  stopNextServer,
  closeFakeSmtp,
  restoreGeneratedTypeConfigs,
]);
const reportCleanupError = createCleanupErrorReporter((error) => {
  console.error(error instanceof Error ? error.message : error);
});
const termination = installTerminationHandlers({ processLike: process, cleanup, onError: reportCleanupError });

function waitForDelayOrAbort(delay, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function waitForServer(signal) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) return;
    if (server?.exitCode !== null || server?.signalCode !== null) {
      throw new Error(`E2E 本地服务器提前退出，退出码：${server?.exitCode ?? server?.signalCode}`);
    }
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: 3100 });
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (error) reject(error);
          else resolve();
        };
        socket.once("connect", () => finish());
        socket.once("error", finish);
        socket.setTimeout(2_000, () => finish(new Error("E2E TCP 探测超时")));
        signal.addEventListener("abort", () => finish(new Error("E2E 启动已取消")), { once: true });
      });
      return;
    } catch {
      // The development server is still starting.
    }
    if (signal.aborted) return;
    await waitForDelayOrAbort(1_000, signal);
  }
  throw new Error("E2E 本地服务器端口在 120 秒内未就绪");
}

function startPlaywrightRunner(playwrightArgs) {
  runner = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", ...playwrightArgs],
    { cwd: projectRoot, env: environment, stdio: "inherit", windowsHide: true },
  );
  runnerCompletion = new Promise((resolve) => {
    runner.once("error", () => resolve(1));
    runner.once("close", (code) => resolve(code ?? 1));
  });
  const child = runner;
  stopRunnerResource = createIdempotentCleanup([() => stopChildProcess(child)]);
}

async function main() {
  const isTerminated = () => termination.exitCode !== null;
  if (!await runAbortableStartup({
    start: startFakeSmtp,
    dispose: closeFakeSmtp,
    isTerminated,
    terminationSignal: termination.signal,
    onDisposeError: reportCleanupError,
  })) return 1;
  if (!await runAbortableStartup({
    start: () => prepareE2eDatabase(termination.signal),
    dispose: async () => undefined,
    isTerminated,
    terminationSignal: termination.signal,
    onDisposeError: reportCleanupError,
  })) return 1;
  if (!await runAbortableStartup({
    start: startNextServer,
    dispose: stopNextServer,
    isTerminated,
    terminationSignal: termination.signal,
    onDisposeError: reportCleanupError,
  })) return 1;
  if (!await runAbortableStartup({
    start: () => waitForServer(termination.signal),
    dispose: stopNextServer,
    isTerminated,
    terminationSignal: termination.signal,
    onDisposeError: reportCleanupError,
  })) return 1;
  const playwrightArgs = normalizeE2eArgs(process.argv.slice(2));
  if (!await runAbortableStartup({
    start: () => startPlaywrightRunner(playwrightArgs),
    dispose: stopPlaywrightRunner,
    isTerminated,
    terminationSignal: termination.signal,
    onDisposeError: reportCleanupError,
  })) return 1;
  return runnerCompletion;
}

const exitCode = await runWithCleanup({
  run: main,
  cleanup,
  onRunError: (error) => {
    if (termination.exitCode === null) console.error(error instanceof Error ? error.message : error);
  },
  onCleanupError: reportCleanupError,
});
termination.dispose();
process.exitCode = termination.exitCode ?? exitCode;
