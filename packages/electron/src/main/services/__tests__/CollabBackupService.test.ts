import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CollabBackupService } from '../CollabBackupService';

// Controllable seam for the marker-race test: when enabled, a manifest write
// that carries no recovery marker (i.e. a live backup's stale manifest) is
// delayed so the recovery-marker write can land inside its read-modify-write
// window. Off for every other test.
const raceControl = vi.hoisted(() => ({ delayManifestWrites: false }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const writeFile = async (file: unknown, data: unknown, ...rest: unknown[]) => {
    if (
      raceControl.delayManifestWrites &&
      typeof file === 'string' &&
      file.includes('manifest.json') &&
      typeof data === 'string'
    ) {
      // Both manifest writes are delayed past the concurrent reads, but the
      // stale (marker-less) backup write is delayed LONGER, so in the unfixed
      // code it commits last and clobbers the recovery marker.
      await new Promise((resolve) => setTimeout(resolve, data.includes('needs-recovery') ? 20 : 60));
    }
    return (actual.writeFile as (...args: unknown[]) => Promise<void>)(file, data, ...rest);
  };
  return { ...actual, default: actual, writeFile };
});

describe('CollabBackupService', () => {
  let backupRoot: string;
  let service: CollabBackupService;

  beforeEach(async () => {
    backupRoot = await mkdtemp(path.join(tmpdir(), 'nimbalyst-collab-backup-'));
    service = new CollabBackupService({
      backupRoot,
      debounceMs: 0,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });
  });

  afterEach(async () => {
    service.dispose();
    await rm(backupRoot, { recursive: true, force: true });
  });

  it('does not replace a good backup with empty or much-smaller content', async () => {
    const original = '# Recovery copy\n\n' + 'important content '.repeat(40);
    const input = {
      documentId: 'doc-1',
      orgId: 'org-1',
      projectId: null,
      documentType: 'markdown',
      title: 'Recovery copy',
      relativePath: 'docs/recovery.md',
      kind: 'document' as const,
      extension: '.md',
    };

    expect(await service.backupNow({ ...input, plaintext: original })).toMatchObject({
      success: true,
    });
    expect(await service.backupNow({ ...input, plaintext: '' })).toMatchObject({
      success: false,
      skipped: 'size-guard',
    });
    expect(await service.backupNow({ ...input, plaintext: 'tiny' })).toMatchObject({
      success: false,
      skipped: 'size-guard',
    });

    const backupPath = path.join(backupRoot, 'org-1', '_primary', 'documents', 'doc-1.md');
    expect(await readFile(backupPath, 'utf8')).toBe(original);

    const manifest = JSON.parse(
      await readFile(path.join(backupRoot, 'org-1', '_primary', 'manifest.json'), 'utf8'),
    );
    expect(manifest.documents['doc-1']).toMatchObject({
      kind: 'document',
      relativePath: 'docs/recovery.md',
      byteSize: Buffer.byteLength(original),
    });
  });

  it('round-trips a tracker body through the plaintext recovery copy', async () => {
    const markdown = '# NIM-123\n\nTracker-only recovery content.\n';
    await service.backupNow({
      documentId: 'tracker-content/item-123',
      orgId: 'org-1',
      projectId: 'project-1',
      documentType: 'markdown',
      title: 'NIM-123',
      relativePath: null,
      kind: 'body',
      extension: '.md',
      plaintext: markdown,
    });

    const applyPlaintext = vi.fn(async (_plaintext: string) => undefined);
    const result = await service.restore({
      orgId: 'org-1',
      projectId: 'project-1',
      documentId: 'tracker-content/item-123',
      applyPlaintext,
    });

    expect(result).toEqual({ success: true });
    expect(applyPlaintext).toHaveBeenCalledWith(markdown);
    expect(
      await readFile(path.join(backupRoot, 'org-1', 'project-1', 'bodies', 'item-123.md'), 'utf8'),
    ).toBe(markdown);
  });

  it('debounces live changes and keeps the latest plaintext', async () => {
    const base = {
      documentId: 'doc-live',
      orgId: 'org-1',
      projectId: 'project-1',
      documentType: 'markdown',
      title: 'Live document',
      relativePath: 'live.md',
      kind: 'document' as const,
      extension: '.md',
    };
    service.onContentChanged({ ...base, getPlaintext: () => 'stale' });
    service.onContentChanged({ ...base, getPlaintext: () => 'latest plaintext' });

    await service.flushPending();

    expect(
      await readFile(path.join(backupRoot, 'org-1', 'project-1', 'documents', 'doc-live.md'), 'utf8'),
    ).toBe('latest plaintext');
  });

  it('does not lose the recovery marker when a live backup writes concurrently', async () => {
    // Marker race (backup review finding 2): markNeedsRecovery must be
    // serialized with live backupNow writes on the same project chain, or a
    // debounced backup that read the manifest before the marker landed writes
    // after it and silently erases recoveryState.
    //
    // Deterministic reproduction: delay backupNow's (marker-less) manifest write
    // so the recovery-marker write lands inside backupNow's read-modify-write
    // window. Without the fix backupNow's stale write clobbers the marker; with
    // the fix the two are serialized on the project chain and the marker survives.
    const base = {
      documentId: 'doc-race',
      orgId: 'org-race',
      projectId: 'project-race',
      documentType: 'markdown',
      title: 'Race document',
      relativePath: 'race.md',
      kind: 'document' as const,
      extension: '.md',
    };
    // Seed a non-empty backup so the concurrent write is a real read-modify-write.
    await service.backupNow({ ...base, plaintext: '# initial\n' + 'x'.repeat(200) });

    raceControl.delayManifestWrites = true;
    try {
      await Promise.all([
        service.markNeedsRecovery('org-race', ['project-race'], 'cutover failed'),
        service.backupNow({ ...base, plaintext: '# updated\n' + 'y'.repeat(200) }),
      ]);
    } finally {
      raceControl.delayManifestWrites = false;
    }

    const manifest = JSON.parse(
      await readFile(
        path.join(backupRoot, 'org-race', 'project-race', 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.recoveryState).toMatchObject({
      status: 'needs-recovery',
      reason: 'cutover failed',
    });
    // The concurrent live backup must still have landed too.
    expect(manifest.documents['doc-race']).toBeDefined();
  });

  it('preserves migration recovery metadata on the old project tree', async () => {
    await service.backupNow({
      documentId: 'doc-move',
      orgId: 'org-old',
      projectId: 'project-old',
      documentType: 'markdown',
      title: 'Before move',
      relativePath: 'before.md',
      kind: 'document',
      extension: '.md',
      plaintext: 'recover me',
    });

    expect(await service.markSuperseded(
      { orgId: 'org-old', projectId: 'project-old' },
      { orgId: 'org-new', projectId: 'project-new' },
    )).toBe(true);
    await service.markNeedsRecovery('org-old', ['project-old'], 'cutover failed');

    const manifest = JSON.parse(
      await readFile(path.join(backupRoot, 'org-old', 'project-old', 'manifest.json'), 'utf8'),
    );
    expect(manifest.supersededBy).toEqual({
      orgId: 'org-new',
      projectId: 'project-new',
      at: '2026-07-13T12:00:00.000Z',
    });
    expect(manifest.recoveryState).toEqual({
      status: 'needs-recovery',
      reason: 'cutover failed',
      at: '2026-07-13T12:00:00.000Z',
    });
  });
});
