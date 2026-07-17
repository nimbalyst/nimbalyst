import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

import { logger } from '../utils/logger';

const PRIMARY_PROJECT_DIRECTORY = '_primary';
const DEFAULT_DEBOUNCE_MS = 3_000;
const SIZE_GUARD_RATIO = 0.5;

export type CollabBackupKind = 'document' | 'body';

export interface CollabBackupManifestEntry {
  kind: CollabBackupKind;
  type: string;
  title: string;
  relativePath: string | null;
  ext: string;
  lastBackupAt: string;
  contentHash: string;
  byteSize: number;
}

export interface CollabBackupManifest {
  orgId: string;
  projectId: string | null;
  updatedAt: string;
  documents: Record<string, CollabBackupManifestEntry>;
  supersededBy?: { orgId: string; projectId: string | null; at: string };
  recoveryState?: { status: 'needs-recovery'; reason: string; at: string };
}

export interface CollabBackupIdentity {
  documentId: string;
  orgId: string;
  projectId: string | null;
  documentType: string;
  title: string;
  relativePath: string | null;
  kind: CollabBackupKind;
  extension: string;
}

export interface CollabBackupContent extends CollabBackupIdentity {
  plaintext: string;
}

export interface CollabBackupChangedInput extends CollabBackupIdentity {
  getPlaintext: () => string | Promise<string>;
}

export interface CollabBackupResult {
  success: boolean;
  skipped?: 'size-guard';
  error?: string;
}

export interface CollabBackupServiceOptions {
  backupRoot?: string;
  debounceMs?: number;
  now?: () => Date;
}

interface PendingBackup {
  input: CollabBackupChangedInput;
  timer: ReturnType<typeof setTimeout>;
}

function safeSegment(value: string): string {
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (/^[a-zA-Z0-9_-]+$/.test(value) && !windowsReserved.test(value)) return value;
  return `_${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function normalizeExtension(extension: string): string {
  const withDot = extension.startsWith('.') ? extension : `.${extension}`;
  if (!/^\.[a-zA-Z0-9._-]+$/.test(withDot)) return '.txt';
  return withDot.toLowerCase();
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export class CollabBackupService {
  private readonly backupRoot: string;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingBackup>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: CollabBackupServiceOptions = {}) {
    this.backupRoot = options.backupRoot ?? path.join(app.getPath('userData'), 'collab-backups');
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? (() => new Date());
  }

  onContentChanged(input: CollabBackupChangedInput): void {
    const key = this.documentKey(input);
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void Promise.resolve(input.getPlaintext())
        .then((plaintext) => this.backupNow({ ...input, plaintext }))
        .then((result) => {
          if (!result.success && result.skipped !== 'size-guard') {
            logger.main.warn('[CollabBackup] Live backup failed', {
              documentId: input.documentId,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          logger.main.warn('[CollabBackup] Plaintext serialization failed', {
            documentId: input.documentId,
            error,
          });
        });
    }, this.debounceMs);
    this.pending.set(key, { input, timer });
  }

  /**
   * Serialize a manifest read-modify-write on the per-project chain. Every
   * writer of a project's manifest -- live/sweep backups AND the recovery-state
   * markers -- must run through here, or a marker write can interleave with a
   * live backup's read-modify-write and be silently overwritten (finding 2).
   */
  private runOnProjectChain<T>(projectKey: string, task: () => Promise<T>): Promise<T> {
    const prior = this.writeChains.get(projectKey) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(task);
    // The chain link must never reject, or the next waiter's `.catch` swallows
    // it but the unhandled rejection still surfaces; keep failures local to run.
    const link = run.then(() => undefined, () => undefined);
    this.writeChains.set(projectKey, link);
    void link.finally(() => {
      if (this.writeChains.get(projectKey) === link) this.writeChains.delete(projectKey);
    });
    return run;
  }

  async backupNow(input: CollabBackupContent): Promise<CollabBackupResult> {
    return this.runOnProjectChain(
      this.projectKey(input.orgId, input.projectId),
      () => this.writeBackup(input),
    ).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async restore(input: {
    orgId: string;
    projectId: string | null;
    documentId: string;
    applyPlaintext: (plaintext: string) => Promise<void>;
  }): Promise<CollabBackupResult> {
    try {
      const manifest = await this.readManifest(input.orgId, input.projectId);
      const entry = manifest?.documents[input.documentId];
      if (!entry) return { success: false, error: 'Backup not found' };
      const filePath = this.contentPath(
        input.orgId,
        input.projectId,
        input.documentId,
        entry.kind,
        entry.ext,
      );
      const plaintext = await fs.readFile(filePath, 'utf8');
      await input.applyPlaintext(plaintext);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listProjectBackups(
    orgId: string,
    projectId: string | null,
  ): Promise<CollabBackupManifest | null> {
    return this.readManifest(orgId, projectId);
  }

  async markSuperseded(
    source: { orgId: string; projectId: string | null },
    destination: { orgId: string; projectId: string | null },
  ): Promise<boolean> {
    return this.runOnProjectChain(
      this.projectKey(source.orgId, source.projectId),
      async () => {
        const manifest = await this.readManifest(source.orgId, source.projectId);
        if (!manifest) return false;
        const at = this.now().toISOString();
        manifest.updatedAt = at;
        manifest.supersededBy = { ...destination, at };
        await atomicWrite(
          this.manifestPath(source.orgId, source.projectId),
          JSON.stringify(manifest, null, 2),
        );
        return true;
      },
    );
  }

  async markNeedsRecovery(
    orgId: string,
    projectIds: Array<string | null>,
    reason: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    for (const projectId of new Set(projectIds)) {
      await this.runOnProjectChain(this.projectKey(orgId, projectId), async () => {
        const manifest = await this.readManifest(orgId, projectId);
        if (!manifest) return;
        manifest.updatedAt = at;
        manifest.recoveryState = { status: 'needs-recovery', reason, at };
        await atomicWrite(
          this.manifestPath(orgId, projectId),
          JSON.stringify(manifest, null, 2),
        );
      });
    }
  }

  async flushPending(): Promise<void> {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    await Promise.allSettled(pending.map(async ({ input, timer }) => {
      clearTimeout(timer);
      const plaintext = await input.getPlaintext();
      await this.backupNow({ ...input, plaintext });
    }));
  }

  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private async writeBackup(input: CollabBackupContent): Promise<CollabBackupResult> {
    try {
      const ext = normalizeExtension(input.extension);
      const filePath = this.contentPath(
        input.orgId,
        input.projectId,
        input.documentId,
        input.kind,
        ext,
      );
      const byteSize = Buffer.byteLength(input.plaintext, 'utf8');
      let currentSize = 0;
      try {
        currentSize = (await fs.stat(filePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (currentSize > 0 && (byteSize === 0 || byteSize < currentSize * SIZE_GUARD_RATIO)) {
        logger.main.warn('[CollabBackup] Refusing much-smaller replacement', {
          documentId: input.documentId,
          currentSize,
          nextSize: byteSize,
        });
        return { success: false, skipped: 'size-guard' };
      }

      await atomicWrite(filePath, input.plaintext);

      const timestamp = this.now().toISOString();
      const manifest = (await this.readManifest(input.orgId, input.projectId)) ?? {
        orgId: input.orgId,
        projectId: input.projectId,
        updatedAt: timestamp,
        documents: {},
      };
      manifest.updatedAt = timestamp;
      manifest.documents[input.documentId] = {
        kind: input.kind,
        type: input.documentType,
        title: input.title,
        relativePath: input.relativePath,
        ext: ext.slice(1),
        lastBackupAt: timestamp,
        contentHash: createHash('sha256').update(input.plaintext).digest('hex'),
        byteSize,
      };
      await atomicWrite(
        this.manifestPath(input.orgId, input.projectId),
        JSON.stringify(manifest, null, 2),
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readManifest(
    orgId: string,
    projectId: string | null,
  ): Promise<CollabBackupManifest | null> {
    try {
      const raw = await fs.readFile(this.manifestPath(orgId, projectId), 'utf8');
      return JSON.parse(raw) as CollabBackupManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private documentKey(input: Pick<CollabBackupIdentity, 'orgId' | 'projectId' | 'documentId'>): string {
    return `${this.projectKey(input.orgId, input.projectId)}::${input.documentId}`;
  }

  private projectKey(orgId: string, projectId: string | null): string {
    return `${orgId}::${projectId ?? PRIMARY_PROJECT_DIRECTORY}`;
  }

  private projectDirectory(orgId: string, projectId: string | null): string {
    return path.join(
      this.backupRoot,
      safeSegment(orgId),
      projectId ? safeSegment(projectId) : PRIMARY_PROJECT_DIRECTORY,
    );
  }

  private manifestPath(orgId: string, projectId: string | null): string {
    return path.join(this.projectDirectory(orgId, projectId), 'manifest.json');
  }

  private contentPath(
    orgId: string,
    projectId: string | null,
    documentId: string,
    kind: CollabBackupKind,
    extension: string,
  ): string {
    const ext = normalizeExtension(extension);
    const id = kind === 'body' && documentId.startsWith('tracker-content/')
      ? documentId.slice('tracker-content/'.length)
      : documentId;
    return path.join(
      this.projectDirectory(orgId, projectId),
      kind === 'body' ? 'bodies' : 'documents',
      `${safeSegment(id)}${ext}`,
    );
  }
}

let collabBackupService: CollabBackupService | null = null;

export function getCollabBackupService(): CollabBackupService {
  if (!collabBackupService) collabBackupService = new CollabBackupService();
  return collabBackupService;
}

export async function flushPendingCollabBackups(): Promise<void> {
  await collabBackupService?.flushPending();
}
