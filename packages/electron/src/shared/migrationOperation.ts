export interface MigrationOperationSnapshot {
  id: string;
  revision: number;
  kind: "dry-run" | "adoption" | "migration" | "rollback";
  status:
    | "running"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "awaiting-restart";
  progress?: unknown;
  phase?: unknown;
  response?: unknown;
  requiresRestart?: boolean;
}

export function newerMigrationOperation(
  current: MigrationOperationSnapshot | null,
  incoming: MigrationOperationSnapshot
): boolean {
  return !current || incoming.revision > current.revision;
}
