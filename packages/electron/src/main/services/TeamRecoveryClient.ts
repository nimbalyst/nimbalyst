import * as Y from 'yjs';
import { basename } from 'node:path';
import { canonicalRecoveryValue, recoveryContentValue, type RecoveryInventoryKind, type RecoveryStoredInventoryPage, type TeamRecoveryDiagnostics, type TeamRecoveryInventory, type TeamRecoveryOperation } from '@nimbalyst/collab-protocol';
import { collectRecoveryInventory } from './TeamRecoveryInventory';
import { prepareTeamRecovery, recoveryDigest, type PreparedTeamRecovery, type RecoverySourceRoom } from './TeamRecoveryPreparation';
import { assertRecoveryBundleFits, type TeamRecoveryBundle } from './TeamRecoveryBundle';
import type { TeamRecoveryOverview } from '../../shared/teamRecovery';

interface RecoveryArtifact {
  inventory: TeamRecoveryInventory;
  sources: RecoverySourceRoom[];
  encryptedAssets: Array<{ documentId: string; id: string; base64: string; iv: string }>;
  prepared: PreparedTeamRecovery;
}
interface Dependencies {
  api(path: string, body?: Record<string, unknown>): Promise<any>;
  collect(workspacePath: string, inventory: TeamRecoveryInventory): Promise<TeamRecoveryBundle>;
  withKeys<T>(action: (decrypt: (ciphertext: string, iv: string, aad?: string) => Buffer, unreadableFiles: string[]) => Promise<T>): Promise<T>;
  itemPayload(row: Record<string, any>): string;
  clientId(): string;
  saveFile(): Promise<string | null>;
  openFile(): Promise<string | null>;
  writeBundle(filename: string, bundle: TeamRecoveryBundle, password: string): Promise<void>;
  readBundle(filename: string, password: string): Promise<TeamRecoveryBundle>;
}

/**
 * The only validation of the diagnostics response. The server also rechecks
 * authority on every action; this keeps a malformed or foreign response from
 * being treated as evidence for recovery or written into a support report.
 */
export function validateRecoveryDiagnostics(value: unknown, orgId: string): TeamRecoveryDiagnostics {
  if (!value || typeof value !== 'object') throw new Error('Invalid recovery diagnostics');
  const data = value as TeamRecoveryDiagnostics;
  if (data.version !== 1 || data.orgId !== orgId) throw new Error('Recovery diagnostics organization mismatch');
  if (!['legacy', 'ready', 'missing-key', 'key-unavailable', 'unknown-mode'].includes(data.status)
    || !['absent', 'available', 'failed'].includes(data.keyProbe)
    || typeof data.keyPresent !== 'boolean'
    || !Array.isArray(data.projects)
    || data.projects.some(p => !p || typeof p.projectId !== 'string' || typeof p.teamProjectId !== 'string')
    || (data.uncoveredContent !== undefined && (!Array.isArray(data.uncoveredContent) || data.uncoveredContent.some(kind => typeof kind !== 'string')))) {
    throw new Error('Invalid recovery diagnostics; organization custody could not be verified');
  }
  return data;
}

/** Main-process controller. The renderer receives counts and blockers, never keys or source content. */
export class TeamRecoveryClient {
  private inventory: TeamRecoveryInventory | null = null;
  private sources: RecoverySourceRoom[] = [];
  private encryptedAssets: RecoveryArtifact['encryptedAssets'] = [];
  private bundles: TeamRecoveryBundle[] = [];
  private prepared: PreparedTeamRecovery | null = null;
  private savedPath: string | null = null;
  private operation: TeamRecoveryOperation | null = null;
  private unreadableKeyFiles: string[] = [];

  constructor(readonly orgId: string, private readonly deps: Dependencies) {}

  overview(): TeamRecoveryOverview {
    return { orgId: this.orgId, diagnostics: this.inventory?.diagnostics ?? null,
      counts: this.prepared?.counts ?? { projects: 0, items: 0, documents: 0, attachments: 0 },
      blockers: this.prepared?.blockers ?? [],
      // File names only: never key bytes, key-bearing paths, or decryption errors.
      notices: this.unreadableKeyFiles.map(file => ({ id: file, reason: `Retained historical keys in ${file} could not be read on this device. Content that needed them is listed as missing.` })),
      ready: !!this.prepared?.manifest, saved: !!this.savedPath,
      artifactName: this.savedPath ? basename(this.savedPath) : null, operation: this.operation,
      independentClient: !!this.operation && this.operation.initiatorClientId !== this.deps.clientId(),
      identityAssignments: this.prepared?.payloads.flatMap(room => room.kind === 'tracker' && 'items' in room.payload
        ? room.payload.items.map(item => ({ projectId: room.id, itemId: item.id, issueKey: item.issueKey, existing: item.expectedRevision !== null })) : []) ?? [] };
  }

  async status(): Promise<TeamRecoveryOverview> {
    const result = await this.control('status');
    this.operation = result.operation;
    return this.overview();
  }

  private control(action: string, values: Record<string, unknown> = {}) {
    return this.deps.api('control', { ...values, action, clientId: this.deps.clientId() });
  }

  async inspect(): Promise<TeamRecoveryOverview> {
    await this.status();
    if (this.operation && this.operation.phase !== 'completed') throw new Error('Recovery is already active. Import its saved bundle to resume or verify it.');
    const diagnostics = validateRecoveryDiagnostics(await this.deps.api('diagnostics'), this.orgId);
    if (diagnostics.status !== 'legacy' || diagnostics.keyProbe === 'failed') throw new Error('This organization needs an encryption service check, rather than legacy recovery');
    this.savedPath = null;
    this.prepared = null;
    this.bundles = [];
    return this.loadInventory(diagnostics);
  }

  private async loadInventory(diagnostics: TeamRecoveryDiagnostics, additionalDocumentIds: string[] = []): Promise<TeamRecoveryOverview> {
    const inventory = await collectRecoveryInventory(diagnostics, (kind, targetId, cursor) => this.deps.api(`inventory?${new URLSearchParams({ kind, targetId, cursor: cursor ?? '' })}`), additionalDocumentIds);
    const sources: RecoverySourceRoom[] = [];
    const encryptedAssets: RecoveryArtifact['encryptedAssets'] = [];
    for (const room of inventory.rooms) {
      const entries: RecoverySourceRoom['entries'] = [];
      let cursor = '';
      do {
        const page = await this.deps.api(`sources?${new URLSearchParams({ kind: room.kind, targetId: room.targetId, cursor })}`) as RecoveryStoredInventoryPage;
        if (!page || page.version !== 1 || page.kind !== room.kind || !Array.isArray(page.entries) || page.entries.length > 20) throw new Error('Invalid original recovery source page');
        for (const entry of page.entries) {
          const inspected = room.entries.find(row => row.id === entry.id);
          if (!inspected || inspected.revision !== entry.revision || recoveryDigest(entry.stored) !== entry.revision || entries.some(row => row.id === entry.id)) throw new Error('Server content changed during inspection; inspect again');
          entries.push(entry);
        }
        if (page.nextCursor && (page.nextCursor === cursor || page.entries.at(-1)?.id !== page.nextCursor)) throw new Error('Original source pagination made no progress');
        cursor = page.nextCursor ?? '';
      } while (cursor);
      if (entries.length !== room.entries.length) throw new Error('Original server source coverage is incomplete');
      sources.push({ ...room, entries });
      if (room.kind === 'assets') for (const entry of room.entries) {
        const asset = await this.deps.api(`asset?${new URLSearchParams({ targetId: room.targetId, assetId: entry.id })}`);
        if (asset.id !== entry.id || typeof asset.base64 !== 'string' || typeof asset.iv !== 'string') throw new Error('Invalid original attachment source');
        encryptedAssets.push({ documentId: room.targetId, ...asset });
      }
    }
    this.inventory = inventory;
    this.sources = sources;
    this.encryptedAssets = encryptedAssets;
    await this.prepare();
    return this.overview();
  }

  async collect(workspacePath: string): Promise<TeamRecoveryOverview> {
    if (!this.inventory) throw new Error('Inspect the organization before collecting local sources');
    if (this.operation && this.operation.phase !== 'completed') throw new Error('Import the operation’s saved bundle to resume; preserve newer edits in the local outbox');
    const bundle = await this.deps.collect(workspacePath, this.inventory);
    if (bundle.orgId !== this.orgId) throw new Error('Local recovery source organization mismatch');
    const workspaceIds = new Set(bundle.projects.map(project => `${project.accountId}:${project.workspacePath}:${project.teamProjectId}`));
    this.bundles = this.bundles.filter(existing => !existing.projects.some(project => workspaceIds.has(`${project.accountId}:${project.workspacePath}:${project.teamProjectId}`)));
    this.bundles.push(bundle);
    this.savedPath = null;
    await this.includeLocalBodyInventory();
    return this.overview();
  }

  private async includeLocalBodyInventory(): Promise<void> {
    const bodies = [...new Set(this.bundles.flatMap(bundle => bundle.trackerRows).filter(row => row.deleted_at == null).map(row => `tracker-content/${row.id}`))];
    if (bodies.some(id => !this.inventory!.rooms.some(room => room.kind === 'updates' && room.targetId === id))) await this.loadInventory(this.inventory!.diagnostics, bodies);
    else await this.prepare();
  }

  private async prepare(): Promise<void> {
    if (!this.inventory) throw new Error('Recovery inspection required');
    this.prepared = await this.deps.withKeys((decrypt, unreadableFiles) => {
      this.unreadableKeyFiles = [...unreadableFiles];
      return prepareTeamRecovery({ inventory: this.inventory!, sources: this.sources, bundles: this.bundles, encryptedAssets: this.encryptedAssets, decrypt, itemPayload: this.deps.itemPayload });
    });
  }

  private artifact(): TeamRecoveryBundle {
    if (!this.inventory || !this.prepared) throw new Error('Inspect and collect recovery sources first');
    const recovery: RecoveryArtifact = { inventory: this.inventory, sources: this.sources, encryptedAssets: this.encryptedAssets, prepared: this.prepared };
    return { version: 1, orgId: this.orgId, createdAt: new Date().toISOString(),
      projects: [...this.bundles.flatMap(bundle => bundle.projects), { recovery }],
      trackerRows: this.bundles.flatMap(bundle => bundle.trackerRows), documents: this.bundles.flatMap(bundle => bundle.documents) };
  }

  async save(password: string): Promise<TeamRecoveryOverview> {
    const bundle = this.artifact();
    // Before the save dialog: an organization too large for one bundle should
    // fail before the user picks a file and waits for encryption.
    assertRecoveryBundleFits(bundle);
    const filename = await this.deps.saveFile();
    if (!filename) return this.overview();
    await this.deps.writeBundle(filename, bundle, password);
    this.savedPath = filename;
    return this.overview();
  }

  async import(password: string): Promise<TeamRecoveryOverview> {
    const filename = await this.deps.openFile();
    if (!filename) return this.overview();
    const bundle = await this.deps.readBundle(filename, password);
    await this.status();
    const artifact = bundle.projects.find(row => row.recovery)?.recovery as RecoveryArtifact | undefined;
    if (this.operation) {
      if (!artifact || !artifact.prepared?.manifest || recoveryDigest(artifact.prepared.manifest) !== this.operation.manifestDigest) throw new Error('This artifact does not match the active recovery operation');
      this.assertPrepared(artifact.prepared);
      this.inventory = artifact.inventory;
      this.sources = artifact.sources;
      this.encryptedAssets = artifact.encryptedAssets;
      this.prepared = artifact.prepared;
      this.bundles = [{ ...bundle, projects: bundle.projects.filter(row => !row.recovery) }];
      this.savedPath = filename;
    } else {
      if (!this.inventory) await this.inspect();
      const contributions: Record<string, unknown>[] = artifact?.prepared?.payloads?.map(room => room.kind === 'team' ? { recoveredMetadata: room.payload }
        : room.kind === 'tracker' ? { teamProjectId: room.id, recoveredTracker: room.payload }
          : { recoveredDocuments: [{ id: room.id, payload: room.payload }] }) ?? [];
      this.bundles.push({ ...bundle, projects: [...bundle.projects.filter(row => !row.recovery), ...contributions] });
      this.savedPath = null;
      await this.includeLocalBodyInventory();
    }
    return this.overview();
  }

  private assertPrepared(prepared: PreparedTeamRecovery): void {
    if (!prepared.manifest || prepared.manifest.orgId !== this.orgId || !Array.isArray(prepared.payloads) || prepared.payloads.length !== prepared.manifest.rooms.length || prepared.blockers.length) throw new Error('Incomplete saved recovery manifest');
    for (const room of prepared.manifest.rooms) {
      const payload = prepared.payloads.find(value => value.kind === room.kind && value.id === room.id);
      if (!payload || recoveryDigest(payload.payload) !== room.digest) throw new Error('Saved recovery content does not match its manifest');
    }
  }

  private async requireSaved(password: string): Promise<PreparedTeamRecovery> {
    if (!this.savedPath || !this.prepared?.manifest) throw new Error('A complete, verified saved recovery bundle is required');
    const disk = await this.deps.readBundle(this.savedPath, password);
    const artifact = disk.projects.find(row => row.recovery)?.recovery as RecoveryArtifact | undefined;
    if (!artifact?.prepared || recoveryDigest(artifact.prepared.manifest) !== recoveryDigest(this.prepared.manifest)) throw new Error('Saved recovery artifact no longer matches the review');
    this.assertPrepared(artifact.prepared);
    return artifact.prepared;
  }

  async restore(password: string): Promise<TeamRecoveryOverview> {
    const prepared = await this.requireSaved(password);
    await this.status();
    if (!this.operation) {
      for (const payload of prepared.payloads) {
        const room = prepared.manifest!.rooms.find(entry => entry.kind === payload.kind && entry.id === payload.id)!;
        await this.control('preview', { room, payload: payload.payload });
      }
      this.operation = (await this.control('start', { manifest: prepared.manifest })).operation;
    }
    if (this.operation!.manifestDigest !== recoveryDigest(prepared.manifest)) throw new Error('Another recovery manifest owns this organization');
    let steps = 0;
    while (this.operation!.phase === 'fenced') {
      if (++steps > prepared.payloads.length + 2) throw new Error('Recovery did not advance; inspect its status before retrying');
      this.operation = (await this.control('advance')).operation;
    }
    // Recheck every source after all write fences are durable, before the first
    // replacement. A source changed during inspection can then be re-collected.
    if (this.operation!.phase === 'restoring') for (const room of prepared.payloads) {
      if (!this.operation!.rooms.find(entry => entry.kind === room.kind && entry.id === room.id)?.restored) await this.control('validate', room);
    }
    if (this.operation!.phase === 'restoring') for (const room of prepared.payloads) {
      if (this.operation!.rooms.find(entry => entry.kind === room.kind && entry.id === room.id)?.restored) continue;
      this.operation = (await this.control('restore', room)).operation;
    }
    return this.overview();
  }

  async reset(): Promise<TeamRecoveryOverview> {
    await this.status();
    if (!this.operation) return this.overview();
    this.operation = (await this.control('reset')).operation;
    const limit = this.operation!.rooms.length + 2;
    for (let step = 0; this.operation && step < limit; step++) this.operation = (await this.control('advance')).operation;
    if (this.operation) throw new Error('Source recheck did not finish; refresh status and retry');
    this.inventory = null; this.sources = []; this.encryptedAssets = []; this.bundles = []; this.prepared = null; this.savedPath = null; this.unreadableKeyFiles = [];
    return this.overview();
  }

  async verify(password: string): Promise<TeamRecoveryOverview> {
    const prepared = await this.requireSaved(password);
    await this.status();
    if (!this.operation || this.operation.manifestDigest !== recoveryDigest(prepared.manifest)) throw new Error('Saved artifact does not match an active recovery operation');
    if (this.operation.initiatorClientId === this.deps.clientId()) throw new Error('Open the saved bundle on a second Nimbalyst device to verify recovery');
    if (this.operation.phase === 'validating') for (const room of prepared.payloads) {
      if (this.operation!.rooms.find(entry => entry.kind === room.kind && entry.id === room.id)?.verified) continue;
      const proof = await this.control('verify-read', { kind: room.kind, id: room.id });
      const expected = prepared.manifest!.rooms.find(entry => entry.kind === room.kind && entry.id === room.id)!;
      if (proof.digest !== expected.digest || canonicalRecoveryValue(recoveryContentValue(room.kind, proof.value)) !== canonicalRecoveryValue(recoveryContentValue(room.kind, room.payload))) throw new Error('Independent readback differs from the saved recovery sources; recovery remains paused');
      if (room.kind === 'document') {
        const document = new Y.Doc();
        try {
          const encoded = proof.value.snapshot;
          if (typeof encoded !== 'string' || encoded.length > 24 * 1024 * 1024) throw new Error('Invalid recovered document');
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.toString('base64') !== encoded) throw new Error('Invalid recovered document encoding');
          Y.applyUpdate(document, bytes);
          if (document.store.pendingStructs || document.store.pendingDs) throw new Error('Recovered document has missing CRDT dependencies');
        } finally { document.destroy(); }
      }
      this.operation = (await this.control('verify-ack', { kind: room.kind, id: room.id, nonce: proof.nonce, digest: proof.digest })).operation;
    }
    let steps = 0;
    while (['validating', 'releasing'].includes(this.operation!.phase)) {
      if (++steps > prepared.payloads.length + 3) throw new Error('Recovery completion did not advance; retry from its saved checkpoint');
      this.operation = (await this.control('advance')).operation;
    }
    return this.overview();
  }
}
