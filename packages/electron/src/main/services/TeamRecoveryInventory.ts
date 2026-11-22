import type { RecoveryInventoryEntry, RecoveryInventoryKind, RecoveryInventoryPage, TeamRecoveryDiagnostics, TeamRecoveryInventory } from '@nimbalyst/collab-protocol';

const MAX_ENTRIES = 100_000;
const MAX_ROOMS = 10_000;

/** A failed page makes the entire report unavailable; partial coverage is never readiness. */
export async function collectRecoveryInventory(
  diagnostics: TeamRecoveryDiagnostics,
  readPage: (kind: RecoveryInventoryKind, targetId: string, cursor: string | null) => Promise<unknown>,
  additionalDocumentIds: string[] = [],
): Promise<TeamRecoveryInventory> {
  const rooms: TeamRecoveryInventory['rooms'] = [];
  let total = 0;
  const collect = async (kind: RecoveryInventoryKind, targetId: string) => {
    if (rooms.length >= MAX_ROOMS) throw new Error('Recovery inventory exceeds the supported room limit');
    const entries: RecoveryInventoryEntry[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let nextIssueNumber: number | undefined, issueKeyPrefix: string | undefined;
    do {
      const page = await readPage(kind, targetId, cursor) as RecoveryInventoryPage;
      if (!page || page.version !== 1 || page.kind !== kind || !Array.isArray(page.entries) || page.entries.length > 100
        || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 512))) {
        throw new Error('Invalid recovery inventory page');
      }
      if (page.nextIssueNumber !== undefined && (!Number.isSafeInteger(page.nextIssueNumber) || page.nextIssueNumber < 1)) throw new Error('Invalid recovery issue allocator');
      if (page.issueKeyPrefix !== undefined && (typeof page.issueKeyPrefix !== 'string' || !/^[A-Z][A-Z0-9_-]*$/.test(page.issueKeyPrefix))) throw new Error('Invalid recovery issue prefix');
      if (cursor !== null && (nextIssueNumber !== page.nextIssueNumber || issueKeyPrefix !== page.issueKeyPrefix)) throw new Error('Recovery issue allocation changed during inspection');
      nextIssueNumber = page.nextIssueNumber; issueKeyPrefix = page.issueKeyPrefix;
      for (const entry of page.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 512
          || typeof entry.revision !== 'string' || !/^[a-f0-9]{64}$/.test(entry.revision)
          || typeof entry.deleted !== 'boolean'
          || ['syncId', 'sequence', 'replacesUpTo'].some(key => { const value = entry[key as keyof RecoveryInventoryEntry]; return value !== undefined && value !== null && (!Number.isSafeInteger(value) || Number(value) < 0); })
          || !(entry.fingerprint === null || typeof entry.fingerprint === 'string')
          || (kind === 'items' && (!(entry.issueKey === null || typeof entry.issueKey === 'string')
            || !(entry.issueNumber === null || (Number.isSafeInteger(entry.issueNumber) && entry.issueNumber! > 0))))) {
          throw new Error('Invalid recovery inventory entry');
        }
        if (ids.has(entry.id)) throw new Error('Recovery inventory did not make progress; retry inspection');
        ids.add(entry.id);
        entries.push(entry);
        if (++total > MAX_ENTRIES) throw new Error('Recovery inventory exceeds the supported record limit');
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (cursors.has(cursor) || page.entries.length === 0 || page.entries.at(-1)?.id !== cursor) {
          throw new Error('Recovery inventory did not make progress; retry inspection');
        }
        cursors.add(cursor);
      }
    } while (cursor !== null);
    rooms.push({ kind, targetId, entries, ...(nextIssueNumber === undefined ? {} : { nextIssueNumber }), ...(issueKeyPrefix === undefined ? {} : { issueKeyPrefix }) });
    return entries;
  };
  const documents = await collect('documents', diagnostics.orgId);
  await collect('folders', diagnostics.orgId);
  const documentIds = new Set([...documents.filter(d => !d.deleted).map(d => d.id), ...additionalDocumentIds]);
  for (const projectId of new Set(diagnostics.projects.map(p => p.teamProjectId))) {
    const items = await collect('items', projectId);
    for (const item of items) if (!item.deleted) documentIds.add(`tracker-content/${item.id}`);
    for (const kind of ['schemas', 'views', 'navigation'] as const) await collect(kind, projectId);
  }
  for (const documentId of documentIds) {
    for (const kind of ['updates', 'snapshots', 'assets'] as const) await collect(kind, documentId);
  }
  return { version: 1, orgId: diagnostics.orgId, inspectedAt: new Date().toISOString(), diagnostics, rooms };
}
