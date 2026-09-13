import { beginDatabaseOperationShutdown } from "./databaseOperationLock";
import { BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger";
import type { MigrationOperationSnapshot } from "../../shared/migrationOperation";
import {
  databaseRequiresRestart,
  onDatabaseMaintenance,
} from "./databaseMaintenance";

let snapshot: MigrationOperationSnapshot | null = null;
let revision = 0;
let dryRunAbort: Int32Array | null = null;
let settlement: Promise<unknown> | null = null;

onDatabaseMaintenance(() => publish({ requiresRestart: databaseRequiresRestart() }));

export function migrationOperationSnapshot(): MigrationOperationSnapshot | null {
  return snapshot;
}
function publish(update: Partial<MigrationOperationSnapshot>): void {
  if (!snapshot) return;
  snapshot = { ...snapshot, ...update, revision: ++revision };
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed())
        window.webContents.send("db:migration:operation", snapshot);
    } catch {
      /* a closing window must not fail migration */
    }
  }
}
export function observeMigrationProgress(
  event: string,
  payload: unknown
): void {
  if (!snapshot || !["running", "cancelling"].includes(snapshot.status)) return;
  if (event === "db:migration:progress") publish({ progress: payload });
  if (event === "db:migration:phase") publish({ phase: payload });
}
export function dryRunCancellationBuffer(): SharedArrayBuffer | undefined {
  return dryRunAbort?.buffer as SharedArrayBuffer | undefined;
}
export function cancelMigrationDryRun(id: string): boolean {
  if (
    !snapshot ||
    snapshot.id !== id ||
    snapshot.kind !== "dry-run" ||
    !dryRunAbort ||
    !["running", "cancelling"].includes(snapshot.status)
  )
    return false;
  Atomics.store(dryRunAbort, 0, 1);
  publish({ status: "cancelling" });
  return true;
}
export async function drainMigrationForQuit(): Promise<void> {
  beginDatabaseOperationShutdown();
  const cancellationRequested = snapshot?.kind === "dry-run"
    ? cancelMigrationDryRun(snapshot.id)
    : false;
  const details = { kind: snapshot?.kind, id: snapshot?.id, cancellationRequested };
  logger.main.info("[Migration] Draining operation before quit", details);
  const warning = setInterval(() => {
    logger.main.warn("[Migration] Still waiting for operation to settle before quit", details);
  }, 30_000);
  try {
    await settlement;
  } finally {
    clearInterval(warning);
  }
}
export function migrationNeedsQuitDrain(): boolean {
  return settlement !== null;
}

export async function runMigrationOperation<T extends { success: boolean }>(
  kind: MigrationOperationSnapshot["kind"],
  action: () => Promise<T>
): Promise<T> {
  snapshot = {
    id: randomUUID(),
    revision: ++revision,
    kind,
    status: "running",
  };
  dryRunAbort =
    kind === "dry-run" ? new Int32Array(new SharedArrayBuffer(4)) : null;
  publish({});
  const run = action();
  settlement = run;
  try {
    const response = await run;
    publish({
      response,
      status: databaseRequiresRestart()
        ? "awaiting-restart"
        : response.success
        ? "succeeded"
        : dryRunAbort && Atomics.load(dryRunAbort, 0)
        ? "cancelled"
        : "failed",
    });
    return response;
  } catch (error) {
    publish({
      status: databaseRequiresRestart() ? "awaiting-restart" : "failed",
      response: { success: false, error: String(error) },
    });
    throw error;
  } finally {
    dryRunAbort = null;
    settlement = null;
  }
}
