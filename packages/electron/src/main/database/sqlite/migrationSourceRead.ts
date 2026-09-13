export const MIGRATION_READ_TIMEOUT_MS = 30_000;
export const MIGRATION_SETTLEMENT_TIMEOUT_MS = 120_000;
export const MIGRATION_BRIDGE_TIMEOUT_MS =
  MIGRATION_SETTLEMENT_TIMEOUT_MS + 10_000;

export function migrationReadError(
  code: "migration_read_timeout" | "migration_source_stalled",
  elapsedMs: number
): Error {
  return Object.assign(
    new Error(
      code === "migration_read_timeout"
        ? "Migration source read exceeded its deadline after finishing"
        : "Migration source read has not finished; another migration cannot start yet"
    ),
    {
      code,
      data: { sourceSettled: code === "migration_read_timeout", elapsedMs },
    }
  );
}

export function isSettledMigrationTimeout(
  error: unknown
): error is Error & { data: { sourceSettled: true; elapsedMs: number } } {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    data?: { sourceSettled?: unknown; elapsedMs?: unknown };
  };
  return (
    value.code === "migration_read_timeout" &&
    value.data?.sourceSettled === true &&
    typeof value.data.elapsedMs === "number" &&
    Number.isFinite(value.data.elapsedMs) &&
    value.data.elapsedMs >= 0
  );
}

/** The caller deadline never cancels or releases the actual source request. */
export class MigrationSourceReader {
  private active = false;

  assertAvailable(): void {
    if (this.active) throw migrationReadError("migration_source_stalled", 0);
  }

  read<T>(
    dispatch: () => Promise<T>,
    softTimeoutMs = MIGRATION_READ_TIMEOUT_MS
  ): Promise<T> {
    this.assertAvailable();
    this.active = true;
    const started = performance.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          migrationReadError(
            "migration_source_stalled",
            performance.now() - started
          )
        );
      }, MIGRATION_SETTLEMENT_TIMEOUT_MS);
      timer.unref?.();
      const release = () => {
        clearTimeout(timer);
        this.active = false;
      };
      // Synchronous dispatch failure must release ownership too. Release before
      // resolving the caller so its next read never races our cleanup microtask.
      Promise.resolve()
        .then(dispatch)
        .then(
          (result) => {
            release();
            const elapsedMs = performance.now() - started;
            if (elapsedMs >= softTimeoutMs)
              reject(migrationReadError("migration_read_timeout", elapsedMs));
            else resolve(result);
          },
          (error) => {
            release();
            // #1468: a late Resource busy / XX000 error must keep its identity.
            reject(error);
          }
        );
    });
  }
}
