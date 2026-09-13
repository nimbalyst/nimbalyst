import React from "react";
import { MaterialSymbol } from "@nimbalyst/runtime/ui/icons/MaterialSymbol";
import type {
  MigrationPhaseEvent as PhaseEvent,
  MigrationProgressEvent as ProgressEvent,
} from "../../../../store/atoms/dbMigration";
import { formatBytes, formatDuration } from "./dbFormat";

export interface DryRunResult {
  summary: {
    historyRowsQuarantined?: number;
    tablesCopied: Array<{ name: string; rows: number }>;
    totalRowsCopied: number;
    durationMs: number;
    foreignKeyViolations: number;
    integrityCheck: string;
    spotCheckCount: number;
  };
  dryRunDir: string;
  sqliteFileBytes: number;
  pgliteDirBytes: number;
}

export function DryRunResultCard({
  result,
}: {
  result: DryRunResult;
}): React.ReactElement {
  const sizeChange = result.sqliteFileBytes - result.pgliteDirBytes;
  const sizeChangePct =
    result.pgliteDirBytes > 0
      ? ((sizeChange / result.pgliteDirBytes) * 100).toFixed(1)
      : "0";
  return (
    <div className="p-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <Stat
          label="Rows copied"
          value={result.summary.totalRowsCopied.toLocaleString()}
        />
        <Stat
          label="Tables"
          value={String(result.summary.tablesCopied.length)}
        />
        <Stat
          label="Duration"
          value={formatDuration(result.summary.durationMs)}
        />
        <Stat
          label="FK violations"
          value={String(result.summary.foreignKeyViolations)}
          ok={result.summary.foreignKeyViolations === 0}
        />
        <Stat
          label="Integrity"
          value={result.summary.integrityCheck}
          ok={result.summary.integrityCheck === "ok"}
        />
        <Stat
          label="On-disk"
          value={`${formatBytes(result.sqliteFileBytes)} vs ${formatBytes(
            result.pgliteDirBytes
          )} (${sizeChange >= 0 ? "+" : ""}${sizeChangePct}%)`}
        />
      </div>

      <HistoryMigrationWarning count={result.summary.historyRowsQuarantined} />
      <details className="mt-2 nim-database-dry-run-per-table">
        <summary className="cursor-pointer text-xs text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]">
          Per-table breakdown ({result.summary.tablesCopied.length} tables)
        </summary>
        <table className="w-full mt-2 text-xs">
          <thead>
            <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
              <th className="py-1 pr-2">Table</th>
              <th className="py-1 text-right">Rows copied</th>
            </tr>
          </thead>
          <tbody>
            {result.summary.tablesCopied.map((t) => (
              <tr
                key={t.name}
                className="border-b border-[var(--nim-border)] last:border-b-0"
              >
                <td className="py-1 pr-2 text-[var(--nim-text)] font-mono">
                  {t.name}
                </td>
                <td className="py-1 text-right text-[var(--nim-text)]">
                  {t.rows.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function Stat({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): React.ReactElement {
  const colorClass =
    ok === false ? "text-[var(--nim-error)]" : "text-[var(--nim-text)]";
  return (
    <div className="flex flex-col gap-0">
      <span className="text-xs text-[var(--nim-text-muted)]">{label}</span>
      <span className={`text-sm font-medium ${colorClass}`}>{value}</span>
    </div>
  );
}

export function DryRunProgress({
  phase,
  progress,
}: {
  phase: PhaseEvent | null;
  progress: ProgressEvent | null;
}): React.ReactElement {
  const phaseKey = phase?.phase ?? progress?.phase ?? "preparing";
  const phaseLabel = PHASE_LABELS[phaseKey] ?? phaseKey;
  const currentTable = progress?.currentTable ?? phase?.info?.currentTable;
  const tableRowsCopied = progress?.tableRowsCopied ?? 0;
  const tableRowsExpected = progress?.tableRowsExpected ?? 0;
  const rowsCopied = progress?.rowsCopied ?? 0;
  const rowsExpected = progress?.rowsExpected ?? 0;
  const tablesCompleted = progress?.tablesCompleted ?? 0;
  const tablesTotal = progress?.tablesTotal ?? 0;
  const percent = progress?.percentOfTotal ?? 0;
  const elapsed = progress?.elapsedMs ?? 0;
  const isCopying = phaseKey === "copying";

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 text-xs nim-database-dry-run-progress">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-[var(--nim-text)]">{phaseLabel}</div>
        {currentTable && (
          <div className="text-[var(--nim-text-muted)]">{currentTable}</div>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--nim-bg-primary)]">
        <div
          className="h-full bg-[var(--nim-primary)] transition-all"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[var(--nim-text-muted)]">
        <span>
          Tables {tablesCompleted} / {tablesTotal}
        </span>
        <span>
          Rows {rowsCopied.toLocaleString()}
          {rowsExpected > 0 && ` / ${rowsExpected.toLocaleString()}`}
        </span>
        <span>Elapsed {formatDuration(elapsed)}</span>
      </div>
      {isCopying && tableRowsExpected > 0 && (
        <div className="text-[var(--nim-text-muted)]">
          This table: {tableRowsCopied.toLocaleString()} /{" "}
          {tableRowsExpected.toLocaleString()}
        </div>
      )}
    </div>
  );
}

export function AdoptDryRunSection({
  available,
  running,
  phase,
  progress,
  error,
  result,
  onAdopt,
}: {
  available: {
    completedAt: string;
    totalRows: number;
    historyRowsQuarantined?: number;
  };
  running: boolean;
  phase: PhaseEvent | null;
  progress: ProgressEvent | null;
  error: string | null;
  result: {
    rowsAdded: number;
    durationMs: number;
    historyRowsQuarantined?: number;
  } | null;
  onAdopt: () => void;
}): React.ReactElement {
  const ageHrs =
    (Date.now() - new Date(available.completedAt).getTime()) / 3_600_000;
  const ageBlurb =
    ageHrs < 1
      ? "less than an hour ago"
      : ageHrs < 24
      ? `${Math.round(ageHrs)} hour${ageHrs >= 1.5 ? "s" : ""} ago`
      : `${Math.round(ageHrs / 24)} day${ageHrs >= 36 ? "s" : ""} ago`;
  return (
    <div className="mt-4 p-4 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] nim-database-adopt-dry-run">
      <div className="text-sm font-medium text-[var(--nim-text)] mb-1">
        Switch to your dry-run SQLite copy
      </div>
      <p className="text-xs text-[var(--nim-text-muted)] mb-3">
        A successful dry-run from {ageBlurb} is saved on disk (
        {available.totalRows.toLocaleString()} rows). Nimbalyst can promote it
        to be your active database — it&apos;ll copy anything new since the
        dry-run, then flip the backend flag. The current PGLite directory is
        preserved for rollback.
      </p>
      <HistoryMigrationWarning
        count={
          result?.historyRowsQuarantined ?? available.historyRowsQuarantined
        }
      />
      <button
        type="button"
        onClick={onAdopt}
        disabled={running}
        className="setting-button inline-flex items-center gap-2 py-1.5 px-3 rounded-md text-sm font-medium bg-[var(--nim-primary)] text-white border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--nim-primary-hover)] nim-database-adopt-button"
      >
        <MaterialSymbol icon={running ? "sync" : "swap_horiz"} size={16} />
        {running ? "Switching..." : "Switch to this SQLite copy"}
      </button>

      {running && (phase || progress) && (
        <DryRunProgress phase={phase} progress={progress} />
      )}

      {error && (
        <div className="mt-3 p-3 rounded-md bg-[rgba(220,38,38,0.1)] border border-[rgba(220,38,38,0.3)] text-sm text-[var(--nim-text)]">
          Switch failed: {error}
        </div>
      )}

      {result && (
        <div className="mt-3 p-3 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] text-sm text-[var(--nim-text)]">
          Switched to SQLite. Caught up {result.rowsAdded.toLocaleString()} new
          row{result.rowsAdded === 1 ? "" : "s"} in{" "}
          {formatDuration(result.durationMs)}. Please relaunch Nimbalyst for the
          change to take effect.
        </div>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  preparing: "Preparing",
  copying: "Copying data",
  "rebuilding-fts": "Rebuilding full-text search index",
  "verifying-counts": "Verifying row counts",
  "verifying-spot-check": "Spot-checking copied rows",
  "verifying-integrity": "Verifying database integrity",
  "verifying-foreign-keys": "Verifying foreign keys",
  finalizing: "Finalizing",
};

export function HistoryMigrationWarning({
  count,
}: {
  count?: number;
}): React.ReactElement | null {
  if (!count) return null;
  return (
    <div
      role="status"
      className="my-3 p-3 rounded-md border border-[var(--nim-border)] text-sm"
    >
      Migration completed with {count.toLocaleString()} document-history{" "}
      {count === 1 ? "entry" : "entries"} omitted. These entries are unavailable
      in history, but their original data is retained in a local recovery
      record. The original PGLite database is also retained. Sessions and
      messages were not skipped.
    </div>
  );
}
