// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Provider } from "jotai";
vi.mock("@nimbalyst/runtime/store", async () => {
  const { createStore } = await import("jotai");
  return { store: createStore() };
});
vi.mock("../../../renderer/components/GlobalSettings/panels/database/MigrationProgressViews", () => ({ HistoryMigrationWarning: () => null }));
import { store } from "@nimbalyst/runtime/store";
import { hydrateMigrationOperation } from "../../../renderer/store/listeners/dbMigrationListeners";
import { DatabaseMaintenanceNotice } from "../../../renderer/components/DatabaseMaintenanceNotice";
const send = vi.hoisted(() => vi.fn());
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../../utils/logger", () => ({ logger: { main: log } }));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => false, webContents: { send } },
    ],
  },
}));
import {
  cancelMigrationDryRun,
  drainMigrationForQuit,
  dryRunCancellationBuffer,
  migrationOperationSnapshot,
  observeMigrationProgress,
  runMigrationOperation,
} from "../migrationOperation";
import {
  beginDatabaseMaintenance,
  endDatabaseMaintenance,
  resetDatabaseMaintenanceForTests,
} from "../databaseMaintenance";
import {
  withDatabaseOperationLock,
  endDatabaseOperationShutdown,
  resetDatabaseOperationLockForTests,
} from "../databaseOperationLock";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetDatabaseMaintenanceForTests();
  resetDatabaseOperationLockForTests();
});

it("allows operations again when quit is abandoned after draining", async () => {
  await drainMigrationForQuit();
  expect((await withDatabaseOperationLock("dry-run", async () => {})).acquired).toBe(false);
  endDatabaseOperationShutdown();
  expect((await withDatabaseOperationLock("dry-run", async () => {})).acquired).toBe(true);
});

it("logs a waiting drain every 30 seconds without releasing ownership and stops logging on settlement", async () => {
  vi.useFakeTimers();
  let finish!: (value: { success: boolean }) => void;
  const run = withDatabaseOperationLock("adoption", () => runMigrationOperation("adoption", () => new Promise<{ success: boolean }>(resolve => { finish = resolve; })));
  const start = migrationOperationSnapshot()!;
  const drain = drainMigrationForQuit();
  await vi.advanceTimersByTimeAsync(60_000);
  const second = await withDatabaseOperationLock("recovery", async () => {});
  finish({ success: true });
  await run;
  await drain;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(second.acquired).toBe(false);
  expect(log.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "adoption", id: start.id, cancellationRequested: false }));
  expect(log.warn).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("broadcasts removal of the restart requirement after a pre-close refusal", async () => {
  const renderNotice = () => renderToStaticMarkup(createElement(Provider, { store }, createElement(DatabaseMaintenanceNotice)));
  await runMigrationOperation("adoption", async () => {
    beginDatabaseMaintenance();
    hydrateMigrationOperation(send.mock.calls.at(-1)![1]);
    expect(renderNotice()).toContain('role="dialog"');
    endDatabaseMaintenance();
    expect(migrationOperationSnapshot()?.requiresRestart).toBe(false);
    expect(send.mock.calls.slice(-2).every(call => call[1].requiresRestart === false)).toBe(true);
    hydrateMigrationOperation(send.mock.calls.at(-1)![1]);
    expect(renderNotice()).toBe("");
    return { success: false };
  });
  expect(migrationOperationSnapshot()?.status).toBe("failed");
});

it("retains ownership while cancellation waits for the worker and publishes the terminal result to both windows", async () => {
  let finish!: (value: { success: boolean; error: string }) => void;
  const run = withDatabaseOperationLock("dry-run", () =>
    runMigrationOperation(
      "dry-run",
      () =>
        new Promise<{ success: boolean; error: string }>((resolve) => {
          finish = resolve;
        })
    )
  );
  const start = migrationOperationSnapshot()!;
  observeMigrationProgress("db:migration:progress", {
    currentTable: "ai_sessions",
    tableRowsCopied: 50,
  });
  expect(migrationOperationSnapshot()?.revision).toBeGreaterThan(
    start.revision
  );
  expect(cancelMigrationDryRun("another-operation")).toBe(false);
  expect(cancelMigrationDryRun(start.id)).toBe(true);
  expect(Atomics.load(new Int32Array(dryRunCancellationBuffer()!), 0)).toBe(1);
  expect(
    (await withDatabaseOperationLock("adoption", async () => {})).acquired
  ).toBe(false);
  let drained = false;
  const drain = drainMigrationForQuit().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish({ success: false, error: "Dry run cancelled" });
  await run;
  await drain;
  expect(migrationOperationSnapshot()).toMatchObject({
    id: start.id,
    status: "cancelled",
    response: { success: false },
  });
  expect(send.mock.calls.slice(-2).map((call) => call[1].status)).toEqual([
    "cancelled",
    "cancelled",
  ]);
});

it("broadcasts maintenance before close and keeps the restart fence after completion", async () => {
  await runMigrationOperation("adoption", async () => {
    beginDatabaseMaintenance();
    expect(migrationOperationSnapshot()?.requiresRestart).toBe(true);
    return { success: true };
  });
  expect(migrationOperationSnapshot()?.status).toBe("awaiting-restart");
  expect(
    (await withDatabaseOperationLock("dry-run", async () => {})).acquired
  ).toBe(false);
});
