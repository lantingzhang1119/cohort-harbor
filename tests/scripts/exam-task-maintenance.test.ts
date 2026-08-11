import { afterEach, describe, expect, it, vi } from "vitest";

import { startTaskAttempt } from "@/features/exam-task-runtime/attempt-service";
import {
  renderExamTaskMaintenanceLaunchAgent,
} from "../../scripts/install-exam-task-maintenance-launch-agent";
import {
  runExamTaskMaintenanceCli,
  runExamTaskMaintenanceMain,
} from "../../scripts/run-exam-task-maintenance";
import { createExamTaskFixture } from "../helpers/exam-task-fixture";

describe("exam task maintenance command", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("runs deadline processing and reminders as an idempotent one-shot command", async () => {
    const fixture = await createExamTaskFixture({
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    cleanup = fixture.testDb.cleanup;
    await startTaskAttempt(
      fixture.testDb.db,
      fixture.assignments[0]!.id,
      fixture.assignments[0]!.userId,
      new Date("2026-08-02T12:00:00.000Z"),
    );
    const output = vi.fn();

    const first = await runExamTaskMaintenanceCli({
      db: fixture.testDb.db,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
      stdout: output,
    });
    const second = await runExamTaskMaintenanceCli({
      db: fixture.testDb.db,
      now: () => new Date("2026-08-03T00:02:00.000Z"),
      stdout: output,
    });

    expect(first).toEqual({
      expired: { inspected: 2, submitted: 1, overdue: 1 },
      reminders: { inspected: 0, created: 0 },
    });
    expect(second).toEqual({
      expired: { inspected: 0, submitted: 0, overdue: 0 },
      reminders: { inspected: 0, created: 0 },
    });
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual(first);
  });

  it("renders a bounded launch agent that periodically invokes the one-shot command", () => {
    const plist = renderExamTaskMaintenanceLaunchAgent({
      label: "org.cohortharbor.exam-task-maintenance",
      outputPath: "/Users/example/Library/LaunchAgents/org.cohortharbor.exam-task-maintenance.plist",
      projectDir: "/Users/example/cohort-harbor",
      nodePath: "/opt/homebrew/bin/node",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      databaseUrl: "file:/Users/example/cohort-harbor/storage/private/demo.db",
      logPath: "/Users/example/Library/Logs/cohort-harbor-exam-maintenance.log",
      intervalSeconds: 300,
    });

    expect(plist).toContain("exam:maintenance");
    expect(plist).toContain("file:/Users/example/cohort-harbor/storage/private/demo.db");
    expect(plist).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  it("refuses to create a worker client without an explicit absolute database", async () => {
    const createDb = vi.fn();
    await expect(runExamTaskMaintenanceMain({ env: {}, createDb })).rejects.toThrow(
      "必须显式配置 DATABASE_URL",
    );
    await expect(runExamTaskMaintenanceMain({
      env: { DATABASE_URL: "file:./storage/private/demo.db" },
      createDb,
    })).rejects.toThrow("必须使用绝对 SQLite 文件路径");
    expect(createDb).not.toHaveBeenCalled();
  });
});
