export interface MigrationCandidate {
  orgId: string;
  role: string;
  membershipType?: string;
}

export interface SilentMigrationDependencies {
  getStatus: (orgId: string) => Promise<'legacy-e2e' | 'server-managed'>;
  migrate: (orgId: string) => Promise<unknown>;
  getFinalizationStatus?: (orgId: string) => Promise<MigrationFinalizationStatus>;
  finalizeDocument?: (orgId: string, documentId: string) => Promise<void>;
  finalizeTitles?: (orgId: string) => Promise<void>;
  onStateChange?: (orgId: string, state: SilentMigrationState) => void;
}

export interface MigrationFinalizationStatus {
  mode: 'legacy-e2e' | 'server-managed';
  complete: boolean;
  pendingDocumentIds: string[];
  staleTitleDocumentIds: string[];
  failedDocumentIds: string[];
  documentsChecked: number;
  finalizedAt: string | null;
  purgedLegacyUpdates?: number;
  purgedLegacySnapshots?: number;
}

export type SilentMigrationState =
  | {
      status: 'migrating';
      startedAt: string;
      documentsCompleted?: number;
      documentsTotal?: number;
      phase?: 'custody' | 'titles' | 'documents' | 'verifying';
    }
  | { status: 'complete'; finishedAt: string }
  | { status: 'stuck'; failedAt: string; message: string; retryAt?: string };

const migrationStates = new Map<string, SilentMigrationState>();
const inFlight = new Set<string>();

/**
 * Per-org cooldowns stop auth-refresh re-entry from becoming a login loop.
 * Failures also get an unref'd timer so finalization retries during the current
 * app run instead of waiting for another launch or incidental team-list read.
 */
const nextAttemptAt = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FAILURE_RETRY_MS = 60_000;
const COMPLETE_RECHECK_MS = 6 * 60 * 60_000;

/** Test/sign-out hook: forget which orgs were scanned so the next run re-checks. */
export function resetSilentMigrationScanState(): void {
  nextAttemptAt.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}

/** Manual retry hook: bypass this org's failure/complete cooldown. */
export function resetSilentMigrationForOrg(orgId: string): void {
  nextAttemptAt.delete(orgId);
  const timer = retryTimers.get(orgId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(orgId);
}

export async function initializeServerManagedOrganization(
  orgId: string,
  dependencies: { setServerManaged: (orgId: string) => Promise<void> },
): Promise<void> {
  if (!orgId) throw new Error('orgId required');
  await dependencies.setServerManaged(orgId);
}

export function getSilentMigrationState(orgId: string): SilentMigrationState | null {
  return migrationStates.get(orgId) ?? null;
}

function canAdminister(candidate: MigrationCandidate): boolean {
  const role = candidate.role.toLowerCase();
  return role === 'admin' || role === 'owner';
}

export async function runSilentTeamEncryptionMigrations(
  candidates: MigrationCandidate[],
  dependencies: SilentMigrationDependencies,
): Promise<{ attempted: number; migrated: number; failed: string[] }> {
  let attempted = 0;
  let migrated = 0;
  const failed: string[] = [];

  for (const candidate of candidates) {
    if (candidate.membershipType && candidate.membershipType !== 'active_member') continue;
    if (!canAdminister(candidate) || inFlight.has(candidate.orgId)) continue;
    if ((nextAttemptAt.get(candidate.orgId) ?? 0) > Date.now()) continue;

    // Claim before any network work: a 401 can refresh auth and synchronously
    // re-enter the scan. The in-flight guard prevents a login loop while the
    // cooldown below guarantees failures retry during this app run.
    inFlight.add(candidate.orgId);
    attempted += 1;
    const startedAt = new Date().toISOString();
    const migrating: SilentMigrationState = { status: 'migrating', startedAt, phase: 'custody' };
    migrationStates.set(candidate.orgId, migrating);
    dependencies.onStateChange?.(candidate.orgId, migrating);
    try {
      const status = await dependencies.getStatus(candidate.orgId);
      if (status === 'legacy-e2e') {
        await dependencies.migrate(candidate.orgId);
        migrated += 1;
      }

      if (dependencies.getFinalizationStatus) {
        let finalization = await dependencies.getFinalizationStatus(candidate.orgId);
        if (finalization.staleTitleDocumentIds.length > 0) {
          if (!dependencies.finalizeTitles) {
            throw new Error('Legacy document titles remain but no title finalizer is available');
          }
          const titleState: SilentMigrationState = { status: 'migrating', startedAt, phase: 'titles' };
          migrationStates.set(candidate.orgId, titleState);
          dependencies.onStateChange?.(candidate.orgId, titleState);
          await dependencies.finalizeTitles(candidate.orgId);
        }

        const pending = finalization.pendingDocumentIds;
        for (let index = 0; index < pending.length; index += 1) {
          if (!dependencies.finalizeDocument) {
            throw new Error('Legacy document rows remain but no document finalizer is available');
          }
          const documentState: SilentMigrationState = {
            status: 'migrating',
            startedAt,
            phase: 'documents',
            documentsCompleted: index,
            documentsTotal: pending.length,
          };
          migrationStates.set(candidate.orgId, documentState);
          dependencies.onStateChange?.(candidate.orgId, documentState);
          await dependencies.finalizeDocument(candidate.orgId, pending[index]);
        }

        const verifying: SilentMigrationState = {
          status: 'migrating',
          startedAt,
          phase: 'verifying',
          documentsCompleted: pending.length,
          documentsTotal: pending.length,
        };
        migrationStates.set(candidate.orgId, verifying);
        dependencies.onStateChange?.(candidate.orgId, verifying);
        finalization = await dependencies.getFinalizationStatus(candidate.orgId);
        if (!finalization.complete) {
          throw new Error(
            `Migration is not finalized: ${finalization.pendingDocumentIds.length} document(s), ` +
            `${finalization.staleTitleDocumentIds.length} title(s), and ` +
            `${finalization.failedDocumentIds.length} verification failure(s) remain`,
          );
        }
      }

      const complete: SilentMigrationState = { status: 'complete', finishedAt: new Date().toISOString() };
      migrationStates.set(candidate.orgId, complete);
      dependencies.onStateChange?.(candidate.orgId, complete);
      nextAttemptAt.set(candidate.orgId, Date.now() + COMPLETE_RECHECK_MS);
      const retryTimer = retryTimers.get(candidate.orgId);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimers.delete(candidate.orgId);
    } catch (error) {
      failed.push(candidate.orgId);
      const retryAtMs = Date.now() + FAILURE_RETRY_MS;
      nextAttemptAt.set(candidate.orgId, retryAtMs);
      const stuck: SilentMigrationState = {
        status: 'stuck',
        failedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        retryAt: new Date(retryAtMs).toISOString(),
      };
      migrationStates.set(candidate.orgId, stuck);
      dependencies.onStateChange?.(candidate.orgId, stuck);
      const existingTimer = retryTimers.get(candidate.orgId);
      if (existingTimer) clearTimeout(existingTimer);
      const retryTimer = setTimeout(() => {
        retryTimers.delete(candidate.orgId);
        nextAttemptAt.delete(candidate.orgId);
        void runSilentTeamEncryptionMigrations([candidate], dependencies);
      }, FAILURE_RETRY_MS);
      retryTimer.unref?.();
      retryTimers.set(candidate.orgId, retryTimer);
    } finally {
      inFlight.delete(candidate.orgId);
    }
  }

  return { attempted, migrated, failed };
}
