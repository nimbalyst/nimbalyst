/** A cutover closes the database used by this process; only restart replaces it. */
let restartRequired = false;
const listeners = new Set<() => void>();
export function onDatabaseMaintenance(listener: () => void): void {
  listeners.add(listener);
}

export function beginDatabaseMaintenance(): void {
  restartRequired = true;
  for (const listener of listeners) listener();
}

export function databaseRequiresRestart(): boolean {
  return restartRequired;
}

/** Only safe when source quiescence was refused, before any cutover. */
export function endDatabaseMaintenance(): void {
  restartRequired = false;
  for (const listener of listeners) listener();
}

export function assertDatabaseAvailable(): void {
  if (restartRequired) {
    throw Object.assign(
      new Error("The database is switching. Restart Nimbalyst to continue."),
      {
        code: "DATABASE_RESTART_REQUIRED",
      }
    );
  }
}

export function resetDatabaseMaintenanceForTests(): void {
  restartRequired = false;
}
