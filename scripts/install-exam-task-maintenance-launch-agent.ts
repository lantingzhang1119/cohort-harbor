import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type ExamTaskMaintenanceLaunchAgentInput = {
  label: string;
  outputPath: string;
  projectDir: string;
  nodePath: string;
  pnpmPath: string;
  databaseUrl: string;
  logPath: string;
  intervalSeconds: number;
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new TypeError(`${label} 必须是明确的绝对路径`);
  return path.resolve(value);
}

export function renderExamTaskMaintenanceLaunchAgent(
  input: ExamTaskMaintenanceLaunchAgentInput,
): string {
  const projectDir = absolute(input.projectDir, "项目路径");
  const nodePath = absolute(input.nodePath, "Node 路径");
  const pnpmPath = absolute(input.pnpmPath, "pnpm 路径");
  const logPath = absolute(input.logPath, "日志路径");
  if (!input.databaseUrl.startsWith("file:") || !path.isAbsolute(input.databaseUrl.slice("file:".length))) {
    throw new TypeError("DATABASE_URL 必须使用绝对 SQLite 文件路径");
  }
  if (!/^[A-Za-z0-9.-]+$/.test(input.label)) throw new TypeError("LaunchAgent label 无效");
  if (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 60) {
    throw new TypeError("运行间隔至少为 60 秒");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>PATH=${xml(`${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
    <string>${xml(pnpmPath)}</string>
    <string>--dir</string>
    <string>${xml(projectDir)}</string>
    <string>exam:maintenance</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATABASE_URL</key><string>${xml(input.databaseUrl)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(projectDir)}</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>StartInterval</key><integer>${input.intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

export async function installExamTaskMaintenanceLaunchAgent(
  input: ExamTaskMaintenanceLaunchAgentInput & { confirmed: boolean },
  options: { allowedRoot?: string } = {},
) {
  if (!input.confirmed) throw new Error("必须使用 --confirm 显式确认安装 LaunchAgent");
  const allowedRoot = path.resolve(
    options.allowedRoot ?? path.join(homedir(), "Library", "LaunchAgents"),
  );
  const outputPath = absolute(input.outputPath, "输出路径");
  if (outputPath !== allowedRoot && !outputPath.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("LaunchAgent 输出路径必须位于明确的用户 LaunchAgents 目录");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(input.logPath), { recursive: true });
  await writeFile(outputPath, renderExamTaskMaintenanceLaunchAgent(input), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { outputPath };
}

export function parseExamTaskMaintenanceInstallerArgs(args: string[]) {
  const values: Record<string, string> = {};
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--confirm") {
      confirmed = true;
      continue;
    }
    if (!["--output", "--project-dir", "--node-path", "--pnpm-path", "--database-url", "--log-path", "--label", "--interval-seconds"].includes(key)) {
      throw new TypeError(`未知参数：${key}`);
    }
    const value = args[++index];
    if (!value) throw new TypeError(`${key} 缺少值`);
    values[key] = value;
  }
  if (!values["--output"] || !values["--project-dir"] || !values["--node-path"] || !values["--pnpm-path"] || !values["--database-url"] || !values["--log-path"]) {
    throw new TypeError("必须显式提供 --output、--project-dir、--node-path、--pnpm-path、--database-url 和 --log-path");
  }
  return {
    label: values["--label"] ?? "org.cohortharbor.exam-task-maintenance",
    outputPath: values["--output"],
    projectDir: values["--project-dir"],
    nodePath: values["--node-path"],
    pnpmPath: values["--pnpm-path"],
    databaseUrl: values["--database-url"],
    logPath: absolute(values["--log-path"], "日志路径"),
    intervalSeconds: Number(values["--interval-seconds"] ?? "300"),
    confirmed,
  };
}

async function main() {
  const result = await installExamTaskMaintenanceLaunchAgent(
    parseExamTaskMaintenanceInstallerArgs(process.argv.slice(2)),
  );
  console.log(`已生成 ${result.outputPath}；未自动执行 launchctl。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "考试维护 LaunchAgent 安装失败");
    process.exitCode = 1;
  });
}
