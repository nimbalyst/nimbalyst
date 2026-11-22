import { createHash } from 'node:crypto';
import type { LoadedLocalReplica } from '@nimbalyst/runtime/sync/LocalReplicaStore';
import type { TeamRecoveryBundle } from './TeamRecoveryBundle';
import type { LoadedCollabAsset } from './CollabAssetStore';

type Row = Record<string, unknown>;
const LIMIT = 10_000;
// JSON semantics for one flat entry without copying its encoded strings: the
// recovery digest refuses undefined, and the saved bundle drops it.
const portable = (row: Row): Row => Object.fromEntries(Object.entries(row).flatMap(([key, value]) =>
  value === undefined ? [] : [[key, typeof value === 'number' && !Number.isFinite(value) ? null : value]]));

/** Read only through the live application's database and credential-backed replica store. */
export async function collectRecoverySources(input: {
  orgId: string; accountId: string; workspacePath: string; teamProjectId: string;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  sharing: (type: string) => 'team' | 'personal' | 'unknown';
  includeItem?: (row: Row) => boolean;
  readReplica: (documentId: string) => Promise<LoadedLocalReplica | null>;
  readAsset?: (documentId: string, assetId: string) => Promise<LoadedCollabAsset | null>;
  documentIds?: string[];
  primaryProjectId?: string;
}): Promise<TeamRecoveryBundle> {
  const { orgId, accountId, workspacePath, teamProjectId } = input;
  if (!orgId || !accountId || !workspacePath || !teamProjectId) throw new Error('Explicit recovery organization, account, workspace and project required');
  const rows = async (table: string, column: string, value: string) => {
    // Table/column names below are compile-time constants, never supplied by the renderer or bundle.
    const result = await input.query(`SELECT * FROM ${table} WHERE ${column} = $1 LIMIT ${LIMIT + 1}`, [value]);
    if (result.rows.length > LIMIT) throw new Error(`Recovery source limit exceeded for ${table}`);
    // PGLite returns Date objects; SQLite returns strings. Use the same portable
    // representation that the authenticated bundle writes and reads back.
    return JSON.parse(JSON.stringify(result.rows)) as Row[];
  };
  const rawItems = await rows('tracker_items', 'workspace', workspacePath);
  const trackerRows: Row[] = [];
  let privateItemCount = 0;
  for (const row of rawItems) {
    const policy = input.sharing(String(row.type));
    if (policy === 'unknown') throw new Error(`Load the sharing policy for ${String(row.type)} before collecting recovery sources`);
    if (policy === 'personal') { privateItemCount++; continue; }
    if (input.includeItem && !input.includeItem(row)) { privateItemCount++; continue; }
    // A dotted key is private. Never turn it into a shared reservation.
    if (typeof row.issue_key === 'string' && row.issue_key.includes('.')) { privateItemCount++; continue; }
    trackerRows.push({ ...row, recoveryProjectId: teamProjectId });
  }
  const itemIds = new Set(trackerRows.map(row => String(row.id)));
  const schemas = (await rows('tracker_type_defs', 'workspace', workspacePath)).filter(row => input.sharing(String(row.type)) === 'team');
  const navigation = (await rows('tracker_type_navigation', 'workspace', workspacePath)).filter(row => {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') throw new Error('Invalid recovery navigation source');
    if (payload.kind === 'folder') return payload.ownership === 'team' || (payload.ownership == null && row.sync_id != null);
    const policy = input.sharing(String(payload.trackerType));
    if (policy === 'unknown') throw new Error('Load the navigation sharing policy before collecting recovery sources');
    return policy === 'team';
  });
  const views = await rows('tracker_shared_saved_views', 'workspace', workspacePath);
  const transactions = (await rows('tracker_transactions', 'workspace_path', workspacePath)).filter(row => itemIds.has(String(row.item_id)));
  const origins = (await rows('collab_local_origins', 'org_id', orgId)).filter(row => (row.project_id ?? input.primaryProjectId) === teamProjectId);
  const documentIds = new Set([...(input.documentIds ?? []), ...origins.map(row => String(row.document_id)),
    ...trackerRows.filter(row => row.deleted_at == null).map(row => `tracker-content/${String(row.id)}`)]);
  if (documentIds.size > LIMIT) throw new Error('Recovery document source limit exceeded');
  const documents: Row[] = [];
  // Identities only: the cached ciphertext column is read once, by the
  // credential-backed asset store below, rather than for every org row here.
  const assetIdentities = await input.query(`SELECT document_id, asset_id FROM collab_document_assets WHERE org_id = $1 AND account_id = $2 LIMIT ${LIMIT + 1}`, [orgId, accountId]);
  if (assetIdentities.rows.length > LIMIT) throw new Error('Recovery source limit exceeded for collab_document_assets');
  const assetRows = assetIdentities.rows.filter(row => documentIds.has(String(row.document_id)));
  const assets: Row[] = [];
  for (const row of assetRows) {
    const documentId = String(row.document_id), assetId = String(row.asset_id);
    try {
      const asset = await input.readAsset?.(documentId, assetId);
      if (!asset) { assets.push({ documentId, assetId, verdict: 'missing' }); continue; }
      if (asset.identity.accountId !== accountId || asset.identity.orgId !== orgId || asset.identity.documentId !== documentId || asset.identity.assetId !== assetId) throw new Error('Asset identity mismatch');
      assets.push(portable({ documentId, assetId, verdict: 'complete', mimeType: asset.mimeType, fileName: asset.fileName,
        base64: Buffer.from(asset.bytes).toString('base64'), sha256: createHash('sha256').update(asset.bytes).digest('hex'), uploadState: asset.uploadState }));
    } catch { assets.push({ documentId, assetId, verdict: 'unreadable' }); }
  }
  for (const documentId of documentIds) {
    let replica: LoadedLocalReplica | null;
    try { replica = await input.readReplica(documentId); }
    catch { documents.push({ documentId, source: 'local-replica', verdict: 'unreadable' }); continue; }
    if (!replica || replica.completeness !== 'complete') {
      documents.push({ documentId, source: 'local-replica', verdict: replica?.completeness ?? 'missing' });
      continue;
    }
    if (replica.identity.orgId !== orgId || replica.identity.accountId !== accountId || replica.identity.documentId !== documentId) throw new Error('Recovery replica identity mismatch');
    const encode = (bytes: Uint8Array) => ({ base64: Buffer.from(bytes).toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
    documents.push(portable({ documentId, source: 'local-replica', verdict: 'complete', documentType: replica.documentType,
      encodingVersion: replica.encodingVersion, snapshotGeneration: replica.snapshotGeneration, lastServerSeq: replica.lastServerSeq,
      snapshot: replica.snapshot ? encode(replica.snapshot) : null,
      updates: replica.updates.map(update => portable({ ...update, update: encode(update.update) })),
      outbox: replica.outbox.map(update => portable({ ...update, update: encode(update.update) })),
    }));
  }
  // Database rows were normalized as they were read. Replica and attachment
  // entries hold only strings, numbers and nulls, so the large encoded bytes
  // are not copied again by a whole-bundle JSON round trip.
  return { version: 1, orgId, createdAt: new Date().toISOString(), trackerRows, documents,
    projects: [{ teamProjectId, workspacePath, accountId, privateItemCount, schemas, navigation, views, transactions, origins, assets }],
  };
}
