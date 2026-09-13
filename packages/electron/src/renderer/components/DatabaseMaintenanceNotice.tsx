import React from "react";
import { HistoryMigrationWarning } from "./GlobalSettings/panels/database/MigrationProgressViews";
import { useAtomValue } from "jotai";
import { dbMigrationOperationAtom } from "../store/atoms/dbMigration";

/** Mounted once per window; cutover closes the database for every window. */
export function DatabaseMaintenanceNotice(): React.ReactElement | null {
  const operation = useAtomValue(dbMigrationOperationAtom);
  if (!operation?.requiresRestart) return null;
  const response = operation.response as
    | {
        result?: { historyRowsQuarantined?: number };
        summary?: { historyRowsQuarantined?: number };
      }
    | undefined;
  const ready = operation.status === "awaiting-restart";
  const rollback = operation.kind === "rollback";
  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Database switch"
    >
      <div className="max-w-md rounded-lg p-6 bg-[var(--nim-bg-primary)] text-[var(--nim-text)] shadow-xl">
        <h2 className="text-lg font-semibold mb-2">
          {ready
            ? "Restart to verify the database"
            : "Finishing the database switch"}
        </h2>
        <p>
          {ready
            ? rollback
              ? "Restart Nimbalyst to reopen the database after rollback. The SQLite copy has been retained."
              : "Nimbalyst will reopen and verify the database on the next startup. The pre-migration copy has been retained."
            : rollback
              ? "The database is paused while the pre-migration copy is restored. Keep Nimbalyst open until this step finishes."
              : "The database is paused while the final changes are copied. Keep Nimbalyst open until this step finishes."}
        </p>
        <HistoryMigrationWarning
          count={
            response?.result?.historyRowsQuarantined ??
            response?.summary?.historyRowsQuarantined
          }
        />
        {ready && (
          <button
            className="setting-button mt-4"
            type="button"
            autoFocus
            onClick={() => {
              void window.electronAPI?.invoke("db:migration:restart");
            }}
          >
            Restart Nimbalyst
          </button>
        )}
      </div>
    </div>
  );
}
