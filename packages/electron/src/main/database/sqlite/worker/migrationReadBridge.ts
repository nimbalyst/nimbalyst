import { MIGRATION_BRIDGE_TIMEOUT_MS } from "../migrationSourceRead";
import type { LivePgliteReader } from "../MigrationOrchestrator";
import type {
  SerializedError,
  PgliteReadResponsePayload,
} from "./workerProtocol";

export function serializeBridgeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { message: String(error) };
  const details = error as Error & { code?: string; data?: unknown };
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    code: details.code,
    data: details.data,
  };
}

export function deserializeBridgeError(error?: SerializedError): Error {
  return Object.assign(new Error(error?.message ?? "Bridge request failed"), {
    ...(error?.name ? { name: error.name } : {}),
    ...(error?.stack ? { stack: error.stack } : {}),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.data !== undefined ? { data: error.data } : {}),
  });
}

/** All migration callers share the completion-aware source bridge. */
export function createMigrationBridgeReader(
  request: (
    event: string,
    payload: unknown,
    timeoutMs: number
  ) => Promise<unknown>
): LivePgliteReader {
  return {
    async queryReadOnly<T>(
      sql: string,
      params?: unknown[],
      timeoutMs = 30_000
    ): Promise<{ rows: T[] }> {
      const result = (await request(
        "pgliteReadRequest",
        { sql, params, timeoutMs },
        MIGRATION_BRIDGE_TIMEOUT_MS
      )) as PgliteReadResponsePayload<T>;
      return { rows: result.rows };
    },
  };
}
