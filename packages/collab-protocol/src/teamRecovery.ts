/** Content-free diagnostics for the self-service recovery of a legacy team. */
export interface TeamRecoveryDiagnostics {
  version: 1;
  orgId: string;
  rawCustodyMode: string | null;
  status: 'legacy' | 'ready' | 'missing-key' | 'key-unavailable' | 'unknown-mode';
  keyPresent: boolean;
  keyProbe: 'absent' | 'available' | 'failed';
  dekEpoch: number | null;
  dekFingerprint: string | null;
  projects: Array<{ projectId: string; teamProjectId: string; issueKeyPrefix?: string | null }>;
  primaryProjectId?: string | null;
  /** Stored content recovery does not restore yet. Any entry blocks recovery and the custody marker. */
  uncoveredContent?: RecoveryUncoveredContent[];
}

/** `team-inbox` is also reported when the member count is too large to probe every inbox. */
export type RecoveryUncoveredContent = 'conversations' | 'feedback-requests' | 'team-inbox';

export type RecoveryInventoryKind = 'items' | 'schemas' | 'views' | 'navigation' | 'documents' | 'folders' | 'updates' | 'snapshots' | 'assets';
export interface RecoveryInventoryEntry {
  id: string;
  /** Digest of the complete stored row; used to detect changes before recovery. */
  revision: string;
  fingerprint: string | null;
  deleted: boolean;
  issueKey?: string | null;
  issueNumber?: number | null;
  projectId?: string | null;
  /** Server cursor that a recovered local source must cover, not merely exist beside. */
  syncId?: number;
  sequence?: number;
  replacesUpTo?: number;
}
export interface RecoveryInventoryPage {
  version: 1;
  kind: RecoveryInventoryKind;
  entries: RecoveryInventoryEntry[];
  nextCursor: string | null;
  nextIssueNumber?: number;
  issueKeyPrefix?: string;
}
export interface RecoveryStoredInventoryPage extends Omit<RecoveryInventoryPage, 'entries'> {
  entries: Array<RecoveryInventoryEntry & { stored: Record<string, unknown> }>;
}

export interface TeamRecoveryInventory {
  version: 1;
  orgId: string;
  inspectedAt: string;
  diagnostics: TeamRecoveryDiagnostics;
  rooms: Array<{ kind: RecoveryInventoryKind; targetId: string; entries: RecoveryInventoryEntry[]; nextIssueNumber?: number; issueKeyPrefix?: string }>;
}

export interface RecoveryTrackerSource extends RecoveryIdentity {
  plaintext: string;
  expectedRevision: string | null;
  sourceSyncId: number | null;
}
export interface RecoveryRegistrySource {
  id: string;
  plaintext: string;
  expectedRevision: string | null;
  sourceSyncId: number | null;
}
export interface RecoveryTrackerImport {
  items: RecoveryTrackerSource[];
  schemas: RecoveryRegistrySource[];
  views: RecoveryRegistrySource[];
  navigation: RecoveryRegistrySource[];
}
export interface RecoveryRowReference { id: string; revision: string }
export interface RecoveryAssetSource {
  id: string;
  expectedRevision: string | null;
  base64: string;
  sha256: string;
  fileName: string;
  mimeType: string;
}
export interface RecoveryDocumentImport {
  snapshot: string;
  sourceLastServerSeq: number;
  updates: RecoveryRowReference[];
  snapshots: RecoveryRowReference[];
  assets: RecoveryAssetSource[];
}
export interface RecoveryTeamImport {
  documents: Array<{ id: string; expectedRevision: string; title: string; fields?: string }>;
  folders: Array<{ id: string; expectedRevision: string; name: string }>;
}
export type RecoveryPayload = RecoveryTrackerImport | RecoveryDocumentImport | RecoveryTeamImport;

/** Compare content independently of old storage revisions and newly allocated transport cursors. */
export function recoveryContentValue(kind: RecoveryManifestRoom['kind'], payload: RecoveryPayload): unknown {
  const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (kind === 'tracker') {
    const value = payload as RecoveryTrackerImport;
    return {
      items: sorted(value.items).map(row => ({ id: row.id, issueKey: row.issueKey, issueNumber: row.issueNumber,
        content: { ...JSON.parse(row.plaintext), issueKey: row.issueKey, issueNumber: row.issueNumber } })),
      ...Object.fromEntries((['schemas', 'views', 'navigation'] as const).map(name => [name, sorted(value[name]).map(row => ({ id: row.id, content: JSON.parse(row.plaintext) }))])),
    };
  }
  if (kind === 'document') {
    const value = payload as RecoveryDocumentImport;
    return { snapshot: value.snapshot, assets: sorted(value.assets).map(({ id, base64, sha256, fileName, mimeType }) => ({ id, base64, sha256, fileName, mimeType })) };
  }
  const value = payload as RecoveryTeamImport;
  return { documents: sorted(value.documents).map(row => ({ id: row.id, title: row.title, fields: row.fields == null ? null : JSON.parse(row.fields) })),
    folders: sorted(value.folders).map(({ id, name }) => ({ id, name })) };
}
export interface RecoveryManifestRoom {
  kind: 'team' | 'tracker' | 'document';
  id: string;
  digest: string;
  issueKeyPrefix?: string;
}
export interface TeamRecoveryManifest {
  version: 1;
  orgId: string;
  bundleDigest: string;
  rooms: RecoveryManifestRoom[];
}
export interface TeamRecoveryOperation {
  operationId: string;
  manifestDigest: string;
  manifest: TeamRecoveryManifest;
  phase: 'resetting' | 'fenced' | 'restoring' | 'validating' | 'releasing' | 'completed';
  /** The initiating desktop's own label, for local display only; the server does not trust it. */
  initiatorClientId: string;
  /** Server-derived digest of the initiating sign-in session. Verification must come from a different session. */
  initiatorSession?: string;
  startedAt: string;
  rooms: Array<RecoveryManifestRoom & { fenced: boolean; restored: boolean; verified: boolean; released: boolean }>;
}

export interface RecoveryIdentity {
  id: string;
  issueKey: string | null;
  issueNumber: number | null;
}
export interface RecoveryIdentityBlocker {
  id: string;
  code: 'missing-source' | 'identity-conflict' | 'duplicate-key' | 'duplicate-item' | 'invalid-key' | 'deleted-on-server';
}

/** Stable, type-tagged encoding shared by the desktop reviewer and recovery server. */
export function canonicalRecoveryValue(value: unknown): string {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > 1_000_000 || depth > 64) throw new Error('Recovery value exceeds supported complexity');
    if (entry === null) return ['null'];
    if (typeof entry === 'string' || typeof entry === 'boolean') return [typeof entry, entry];
    if (typeof entry === 'number' && Number.isFinite(entry)) return ['number', entry];
    if (entry instanceof ArrayBuffer) return ['bytes', Array.from(new Uint8Array(entry))];
    if (ArrayBuffer.isView(entry)) return ['bytes', Array.from(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength))];
    if (Array.isArray(entry)) return ['array', entry.map(item => visit(item, depth + 1))];
    if (entry && typeof entry === 'object' && (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)) {
      return ['object', Object.keys(entry).sort().map(key => [key, visit((entry as Record<string, unknown>)[key], depth + 1)])];
    }
    throw new Error('Unsupported recovery value');
  };
  return JSON.stringify(visit(value, 0));
}

/** Normal publication must never be used to recover legacy referenced identities. */
export function planRecoveryIdentities(
  server: Array<RecoveryIdentity & { deleted: boolean }>,
  sources: RecoveryIdentity[],
): { identities: RecoveryIdentity[]; blockers: RecoveryIdentityBlocker[]; nextIssueNumber: number } {
  const blockers: RecoveryIdentityBlocker[] = [];
  const local = new Map<string, RecoveryIdentity>();
  const owners = new Map<string, string>();
  const numberOwners = new Map<number, string>();
  const register = (item: RecoveryIdentity) => {
    if (item.issueKey === null && item.issueNumber === null) return;
    const suffix = item.issueKey?.match(/^([A-Z][A-Z0-9_-]*)-([1-9][0-9]*)$/);
    if (!suffix || !Number.isSafeInteger(item.issueNumber) || item.issueNumber! < 1
      || item.issueNumber! >= Number.MAX_SAFE_INTEGER || Number(suffix[2]) !== item.issueNumber) {
      blockers.push({ id: item.id, code: 'invalid-key' });
      return;
    }
    const owner = owners.get(item.issueKey!);
    const numberOwner = numberOwners.get(item.issueNumber!);
    if ((owner && owner !== item.id) || (numberOwner && numberOwner !== item.id)) blockers.push({ id: item.id, code: 'duplicate-key' });
    owners.set(item.issueKey!, item.id);
    numberOwners.set(item.issueNumber!, item.id);
  };
  for (const item of server) register(item); // Tombstone identities remain reserved.
  for (const item of sources) {
    if (!item.id || local.has(item.id)) blockers.push({ id: item.id, code: 'duplicate-item' });
    local.set(item.id, item);
    register(item);
  }
  for (const stored of server) {
    const source = local.get(stored.id);
    if (!stored.deleted && !source) blockers.push({ id: stored.id, code: 'missing-source' });
    if (stored.deleted && source) blockers.push({ id: stored.id, code: 'deleted-on-server' });
    if (source && (stored.issueKey !== null || stored.issueNumber !== null)
      && (stored.issueKey !== source.issueKey || stored.issueNumber !== source.issueNumber)) {
      blockers.push({ id: stored.id, code: 'identity-conflict' });
    }
  }
  const identities = blockers.length ? [] : [...local.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let nextIssueNumber = 1;
  for (const number of numberOwners.keys()) nextIssueNumber = Math.max(nextIssueNumber, number + 1);
  return { identities, blockers, nextIssueNumber };
}
