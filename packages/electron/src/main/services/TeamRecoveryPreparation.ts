import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { canonicalRecoveryValue, parseTrackerItemPayload, planRecoveryIdentities, type RecoveryInventoryKind, type RecoveryInventoryEntry, type RecoveryPayload, type RecoveryTrackerImport, type RecoveryTeamImport, type RecoveryDocumentImport, type RecoveryRegistrySource, type TeamRecoveryInventory, type TeamRecoveryManifest } from '@nimbalyst/collab-protocol';
import type { TeamRecoveryBundle } from './TeamRecoveryBundle';

type Row = Record<string, any>;
export interface RecoverySourceRoom { kind: RecoveryInventoryKind; targetId: string; entries: Array<RecoveryInventoryEntry & { stored: Row }> }
export interface PreparedTeamRecovery {
  manifest: TeamRecoveryManifest | null;
  payloads: Array<{ kind: 'team' | 'tracker' | 'document'; id: string; payload: RecoveryPayload }>;
  blockers: Array<{ id: string; reason: string }>;
  counts: { projects: number; items: number; documents: number; attachments: number };
}
export function recoveryDigest(value: unknown): string { return createHash('sha256').update(canonicalRecoveryValue(value)).digest('hex'); }
const parse = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const plainJSON = (value: unknown) => JSON.stringify(parse(value));

/** Pure rehearsal. Nothing is uploaded, acknowledged, renumbered, or removed here. */
export async function prepareTeamRecovery(input: {
  inventory: TeamRecoveryInventory; sources: RecoverySourceRoom[]; bundles: TeamRecoveryBundle[];
  decrypt: (ciphertext: string, iv: string, aad?: string) => Buffer;
  itemPayload: (row: Row) => string;
  encryptedAssets?: Array<{ documentId: string; id: string; base64: string; iv: string }>;
}): Promise<PreparedTeamRecovery> {
  const { inventory, bundles } = input;
  const result: PreparedTeamRecovery = { manifest: null, payloads: [], blockers: [], counts: { projects: inventory.diagnostics.projects.length, items: 0, documents: 0, attachments: 0 } };
  if (bundles.some(bundle => bundle.orgId !== inventory.orgId)) throw new Error('Recovery bundle organization mismatch');
  const block = (id: string, reason: string) => result.blockers.push({ id, reason });
  // The server refuses to start while this content exists; surface it at review instead of at Start.
  const uncoveredLabels = { conversations: 'team conversations', 'feedback-requests': 'feedback requests', 'team-inbox': 'team inbox messages' } as const;
  for (const kind of inventory.diagnostics.uncoveredContent ?? []) {
    block(inventory.orgId, `Recovery does not yet cover ${uncoveredLabels[kind] ?? kind}; this organization cannot be recovered in place until it does`);
  }
  const entries =(kind: RecoveryInventoryKind, targetId: string) => inventory.rooms.find(room => room.kind === kind && room.targetId === targetId)?.entries ?? [];
  const stored = (kind: RecoveryInventoryKind, targetId: string, entry: RecoveryInventoryEntry): Row => {
    const source = input.sources.find(room => room.kind === kind && room.targetId === targetId)?.entries.find(row => row.id === entry.id);
    if (!source || source.revision !== entry.revision || recoveryDigest(source.stored) !== entry.revision) throw new Error('Original server source is missing or changed; inspect again');
    return source.stored;
  };
  const text = (row: Row, field: string, ivField: string, aad?: string): string => {
    if (typeof row[field] !== 'string' || typeof row[ivField] !== 'string') throw new Error('Encrypted source is incomplete');
    return row[ivField] === '' ? row[field] : input.decrypt(row[field], row[ivField], aad).toString('utf8');
  };
  const choose = <T>(id: string, values: T[]): T | undefined => {
    if (!values.length) return undefined;
    const hashes = new Set(values.map(recoveryDigest));
    if (hashes.size > 1) { block(id, 'Devices disagree about current content; reconcile their edits before recovery'); return undefined; }
    return values[0];
  };
  const team: RecoveryTeamImport = { documents: [], folders: [] };
  const recoveredMetadata = bundles.flatMap(bundle => bundle.projects).flatMap(project => project.recoveredMetadata ? [project.recoveredMetadata as RecoveryTeamImport] : []);
  for (const kind of ['documents', 'folders'] as const) {
    for (const entry of entries(kind, inventory.orgId)) {
      try {
        const recovered = choose(entry.id, recoveredMetadata.flatMap<RecoveryTeamImport['documents'][number] | RecoveryTeamImport['folders'][number]>(source => source[kind]).filter(source => source.id === entry.id && source.expectedRevision === entry.revision));
        if (recovered) {
          if (kind === 'documents' && 'title' in recovered) team.documents.push(recovered);
          else if (kind === 'folders' && 'name' in recovered) team.folders.push(recovered);
          else throw new Error('Recovery metadata kind mismatch');
          continue;
        }
        const row = stored(kind, inventory.orgId, entry);
        if (kind === 'documents') {
          const title = text(row, 'encrypted_title', 'title_iv');
          const fields = row.encrypted_fields == null ? undefined : text(row, 'encrypted_fields', 'fields_iv');
          team.documents.push({ id: entry.id, expectedRevision: entry.revision, title, ...(fields === undefined ? {} : { fields }) });
        } else team.folders.push({ id: entry.id, expectedRevision: entry.revision, name: text(row, 'encrypted_name', 'name_iv') });
      } catch { block(entry.id, 'A readable current title or folder name is missing; collect sources from another device'); }
    }
  }
  result.payloads.push({ kind: 'team', id: inventory.orgId, payload: team });
  const docIds = new Set(entries('documents', inventory.orgId).map(entry => entry.id));
  const prefixes = new Map<string, string>();
  for (const [index, project] of inventory.diagnostics.projects.entries()) {
    const projectId = project.teamProjectId;
    if (!bundles.some(bundle => bundle.projects.some(source => source.teamProjectId === projectId && typeof source.workspacePath === 'string' && typeof source.accountId === 'string'))) block(projectId, 'Collect a linked folder for this project, including its never-uploaded shared tickets, before recovery');
    const payload: RecoveryTrackerImport = { items: [], schemas: [], views: [], navigation: [] };
    const originals = entries('items', projectId);
    const locals = bundles.flatMap(bundle => bundle.trackerRows).filter(row => row.recoveryProjectId === projectId && row.deleted_at == null);
    const projectSources = bundles.flatMap(bundle => bundle.projects).filter(row => row.teamProjectId === projectId);
    const recoveredTrackers = projectSources.flatMap(row => row.recoveredTracker ? [row.recoveredTracker as RecoveryTrackerImport] : []);
    const recoveredItems = recoveredTrackers.flatMap(source => source.items);
    const ids = new Set([...originals.filter(row => !row.deleted).map(row => row.id), ...locals.map(row => String(row.id)), ...recoveredItems.map(row => row.id)]);
    for (const id of ids) {
      const original = originals.find(row => row.id === id);
      if (original?.deleted) { block(id, 'This item is deleted on the server; recovery cannot resurrect it'); continue; }
      const candidates = locals.filter(row => row.id === id && (original ? Number(row.sync_id) === original.syncId : row.sync_id == null));
      try {
        const contributions = recoveredItems.filter(row => row.id === id && row.expectedRevision === (original?.revision ?? null) && row.sourceSyncId === (original?.syncId ?? null));
        const local = choose(id, [...candidates.map(row => ({ plaintext: input.itemPayload(row), issueKey: row.issue_key ?? null, issueNumber: row.issue_number == null ? null : Number(row.issue_number) })),
          ...contributions.map(({ plaintext, issueKey, issueNumber }) => ({ plaintext, issueKey, issueNumber }))]);
        if (!local && candidates.length > 1) continue;
        const plaintext = local?.plaintext ?? (original ? text(stored('items', projectId, original), 'encrypted_payload', 'iv', `tracker-item:${id}`) : null);
        if (!plaintext) throw new Error('Missing current item');
        if (!parseTrackerItemPayload(plaintext, id).success) throw new Error('Invalid tracker payload');
        const content = JSON.parse(plaintext);
        const issueKey = original?.issueKey ?? local?.issueKey ?? content.issueKey ?? null;
        const issueNumber = original?.issueNumber ?? local?.issueNumber ?? content.issueNumber ?? null;
        // Preserve the local assignment for the identity planner to detect conflicts; never silently adopt another server key.
        if (local && original?.issueKey != null && (local.issueKey !== original.issueKey || local.issueNumber !== original.issueNumber)) { block(id, 'Local and server ticket identities conflict'); continue; }
        payload.items.push({ id, issueKey, issueNumber, plaintext, expectedRevision: original?.revision ?? null, sourceSyncId: original?.syncId ?? null });
        docIds.add(`tracker-content/${id}`);
      } catch { block(id, 'A current readable tracker source is missing or corrupt'); }
    }
    const identities = planRecoveryIdentities(originals.map(row => ({ id: row.id, issueKey: row.issueKey ?? null, issueNumber: row.issueNumber ?? null, deleted: row.deleted })), payload.items);
    identities.blockers.forEach(item => block(item.id, `Ticket identity needs attention: ${item.code}`));
    const knownPrefixes = new Set(payload.items.flatMap(item => item.issueKey ? [item.issueKey.replace(/-[0-9]+$/, '')] : []));
    const registered = (project as { issueKeyPrefix?: string | null }).issueKeyPrefix;
    const allocation = inventory.rooms.find(room => room.kind === 'items' && room.targetId === projectId);
    const prefix = registered || allocation?.issueKeyPrefix || (knownPrefixes.size === 1 ? [...knownPrefixes][0] : inventory.diagnostics.projects.length === 1 ? 'TASK' : `TASK${index + 1}`);
    prefixes.set(projectId, prefix);
    let next = Math.max(identities.nextIssueNumber, allocation?.nextIssueNumber ?? 1);
    for (const item of payload.items) {
      if (item.issueKey === null && item.issueNumber === null) { item.issueNumber = next++; item.issueKey = `${prefix}-${item.issueNumber}`; }
      item.plaintext = JSON.stringify({ ...JSON.parse(item.plaintext), issueKey: item.issueKey, issueNumber: item.issueNumber });
    }
    for (const kind of ['schemas', 'views', 'navigation'] as const) {
      const originalRows = entries(kind, projectId);
      const localRows = projectSources.flatMap(row => Array.isArray(row[kind]) ? row[kind] : []).filter(row => row.deleted_at == null);
      const column = kind === 'schemas' ? 'type' : kind === 'views' ? 'view_id' : 'entry_id';
      const recovered = recoveredTrackers.flatMap(source => source[kind]);
      const registryIds = new Set([...originalRows.filter(row => !row.deleted).map(row => row.id), ...localRows.map(row => String(row[column])), ...recovered.map(row => row.id)]);
      for (const id of registryIds) {
        try {
          const original = originalRows.find(row => row.id === id);
          if (original?.deleted) throw new Error('Registry tombstone');
          const candidates = localRows.filter(row => row[column] === id && (original ? Number(row.sync_id) === original.syncId : row.sync_id == null));
          const contributions = recovered.filter(row => row.id === id && row.expectedRevision === (original?.revision ?? null) && row.sourceSyncId === (original?.syncId ?? null));
          const local = choose(id, [...candidates.map(row => plainJSON(kind === 'schemas' ? row.model : row.payload)), ...contributions.map(row => row.plaintext)]);
          if (!local && candidates.length > 1) continue;
          const context = kind === 'schemas' ? 'tracker-schema' : kind === 'views' ? 'tracker-saved-view' : 'tracker-navigation';
          const plaintext = local ?? (original ? text(stored(kind, projectId, original), 'encrypted_payload', 'iv', `${context}:${id}`) : null);
          if (!plaintext || !JSON.parse(plaintext)) throw new Error('Missing registry source');
          const source: RecoveryRegistrySource = { id, plaintext, expectedRevision: original?.revision ?? null, sourceSyncId: original?.syncId ?? null };
          payload[kind].push(source);
        } catch { block(id, `A current readable ${kind} source is missing or corrupt`); }
      }
    }
    result.counts.items += payload.items.length;
    result.payloads.push({ kind: 'tracker', id: projectId, payload });
  }
  if (new Set(prefixes.values()).size !== prefixes.size) block(inventory.orgId, 'Projects have conflicting issue prefixes; reserve distinct prefixes before recovery');
  for (const id of new Set(bundles.flatMap(bundle => bundle.documents).map(document => String(document.documentId)))) {
    if (!docIds.has(id)) block(id, 'A local shared document has no reviewed server identity; reconcile its registration before recovery');
  }
  for (const documentId of docIds) {
    const doc = new Y.Doc();
    try {
      const updates = entries('updates', documentId), snapshots = entries('snapshots', documentId), assets = entries('assets', documentId);
      const highWatermark = Math.max(0, ...updates.map(row => row.sequence ?? 0), ...snapshots.map(row => row.replacesUpTo ?? 0));
      const localDocs = bundles.flatMap(bundle => bundle.documents).filter(row => row.documentId === documentId && row.verdict === 'complete' && Number(row.lastServerSeq) >= highWatermark);
      const recoveredDocs = bundles.flatMap(bundle => bundle.projects).flatMap(project => project.recoveredDocuments ? project.recoveredDocuments as Array<{ id: string; payload: RecoveryDocumentImport }> : [])
        .filter(source => source.id === documentId && source.payload.sourceLastServerSeq >= highWatermark
          && recoveryDigest(source.payload.updates) === recoveryDigest(updates.map(({ id, revision }) => ({ id, revision })))
          && recoveryDigest(source.payload.snapshots) === recoveryDigest(snapshots.map(({ id, revision }) => ({ id, revision }))));
      const apply = (base64: string) => {
        if (typeof base64 !== 'string' || base64.length > 24 * 1024 * 1024) throw new Error('Invalid recovery document bytes');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.toString('base64') !== base64) throw new Error('Invalid recovery document encoding');
        Y.applyUpdate(doc, bytes);
      };
      if (localDocs.length || recoveredDocs.length) {
        for (const source of recoveredDocs) apply(source.payload.snapshot);
        for (const source of localDocs) {
          if (source.encodingVersion !== 1) throw new Error('Unsupported recovery document encoding');
          const snapshot = source.snapshot as Row | null;
          if (snapshot) apply(snapshot.base64);
          for (const row of [...source.updates as Row[], ...source.outbox as Row[]]) apply(row.update.base64);
        }
      } else {
        if (!updates.length && !snapshots.length) throw new Error('No complete body source');
        const latest = [...snapshots].sort((a, b) => (b.replacesUpTo ?? 0) - (a.replacesUpTo ?? 0))[0];
        const applyStored = (kind: 'updates' | 'snapshots', entry: RecoveryInventoryEntry) => {
          const row = stored(kind, documentId, entry), field = kind === 'updates' ? 'update_data' : 'encrypted_state';
          if (row.iv === '') apply(row[field]);
          else Y.applyUpdate(doc, input.decrypt(row[field], row.iv));
        };
        if (latest) applyStored('snapshots', latest);
        for (const update of [...updates].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) if ((update.sequence ?? 0) > (latest?.replacesUpTo ?? 0)) applyStored('updates', update);
      }
      if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete document CRDT dependencies');
      const payload: RecoveryDocumentImport = { snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), sourceLastServerSeq: highWatermark,
        updates: updates.map(({ id, revision }) => ({ id, revision })), snapshots: snapshots.map(({ id, revision }) => ({ id, revision })), assets: [] };
      const collectedAssets = bundles.flatMap(bundle => bundle.projects).flatMap(row => Array.isArray(row.assets) ? row.assets as Row[] : []).filter(row => row.documentId === documentId);
      const localAssets: Row[] = [...collectedAssets.filter(row => row.verdict === 'complete'),
        ...recoveredDocs.flatMap(source => source.payload.assets.map(asset => ({ ...asset, assetId: asset.id })))];
      // Even unreadable local rows establish an attachment that must be covered
      // by another device or the server; silently filtering them loses uploads.
      const assetIds = new Set([...assets.map(row => row.id), ...collectedAssets.map(row => String(row.assetId)), ...localAssets.map(row => String(row.assetId))]);
      for (const id of assetIds) {
        const original = assets.find(row => row.id === id);
        const local = choose(id, localAssets.filter(row => row.assetId === id).map(row => ({ base64: row.base64 as string, sha256: row.sha256 as string, fileName: row.fileName as string, mimeType: row.mimeType as string })));
        if (local) {
          if (createHash('sha256').update(Buffer.from(local.base64, 'base64')).digest('hex') !== local.sha256) throw new Error('Attachment hash mismatch');
          payload.assets.push({ id, expectedRevision: original?.revision ?? null, ...local });
        } else {
          if (!original) throw new Error('Missing attachment source');
          const row = stored('assets', documentId, original), blob = input.encryptedAssets?.find(asset => asset.documentId === documentId && asset.id === id);
          if (!blob) throw new Error('Missing encrypted attachment bytes');
          const bytes = input.decrypt(blob.base64, blob.iv);
          const metadata = JSON.parse(text(row, 'encrypted_metadata', 'metadata_iv'));
          payload.assets.push({ id, expectedRevision: original.revision, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), fileName: metadata.fileName ?? metadata.name, mimeType: metadata.mimeType ?? row.mime_type ?? 'application/octet-stream' });
        }
      }
      result.counts.documents++;
      result.counts.attachments += payload.assets.length;
      result.payloads.push({ kind: 'document', id: documentId, payload });
    } catch { block(documentId, 'A complete current body or attachment source is missing; collect another device’s encrypted recovery bundle'); }
    finally { doc.destroy(); }
  }
  if (result.payloads.length > 2000) block(inventory.orgId, 'This recovery exceeds the supported limit of 2,000 rooms');
  for (const room of result.payloads) if (JSON.stringify(room.payload).length > (room.kind === 'document' ? 12 : 8) * 1024 * 1024) block(room.id, 'This source exceeds the supported recovery size for one room');
  if (!result.blockers.length) {
    result.manifest = { version: 1, orgId: inventory.orgId, bundleDigest: recoveryDigest({ bundles, sources: input.sources }),
      rooms: result.payloads.map(room => ({ kind: room.kind, id: room.id, digest: recoveryDigest(room.payload), ...(room.kind === 'tracker' ? { issueKeyPrefix: prefixes.get(room.id)! } : {}) })) };
  }
  return result;
}
