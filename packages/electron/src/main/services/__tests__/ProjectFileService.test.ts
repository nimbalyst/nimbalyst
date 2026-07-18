import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectFileConflictError,
  ProjectFileService,
} from '../ProjectFileService';

interface HistoryCall {
  path: string;
  content: string;
  metadata: Record<string, unknown>;
}

describe('ProjectFileService', () => {
  let root: string;
  let historyCalls: HistoryCall[];
  let failHistoryPhase: string | undefined;
  let dirtyPaths: Set<string>;
  let service: ProjectFileService;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-project-file-')));
    historyCalls = [];
    failHistoryPhase = undefined;
    dirtyPaths = new Set();
    service = new ProjectFileService({
      async createSnapshot(filePath, content, _type, _description, metadata) {
        historyCalls.push({ path: filePath, content, metadata });
        if (metadata.projectWritePhase === failHistoryPhase) throw new Error('history failed');
      },
    }, (filePath) => dirtyPaths.has(filePath));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads stable content tokens and reports missing files without inventing content', async () => {
    await fs.writeFile(path.join(root, 'board.tsx'), 'old source');
    const files = await service.read(root, ['board.tsx', 'manual-edits.json']);
    expect(files).toEqual([
      { path: path.join(root, 'board.tsx'), exists: true, content: 'old source', sha256: hash('old source') },
      { path: path.join(root, 'manual-edits.json'), exists: false, content: null, sha256: null },
    ]);
  });

  it('writes source and sidecar as one grouped history entry with a bounded receipt', async () => {
    await fs.writeFile(path.join(root, 'board.tsx'), 'old source');
    const receipt = await service.write(root, {
      label: 'Enable manual edits',
      actor: 'user',
      changes: [
        { path: 'board.tsx', expectedSha256: hash('old source'), content: 'new source' },
        { path: 'manual-edits.json', expectedSha256: null, content: '{"pcb_placements":[]}' },
      ],
    });

    expect(await fs.readFile(path.join(root, 'board.tsx'), 'utf8')).toBe('new source');
    expect(await fs.readFile(path.join(root, 'manual-edits.json'), 'utf8')).toBe('{"pcb_placements":[]}');
    expect(receipt).toMatchObject({ label: 'Enable manual edits', actor: 'user', atomic: false });
    expect(receipt.files).toEqual([
      { path: path.join(root, 'board.tsx'), beforeSha256: hash('old source'), afterSha256: hash('new source') },
      { path: path.join(root, 'manual-edits.json'), beforeSha256: null, afterSha256: hash('{"pcb_placements":[]}') },
    ]);
    expect(new Set(historyCalls.map((call) => call.metadata.projectWriteId))).toEqual(new Set([receipt.id]));
    expect(historyCalls.map((call) => call.metadata.projectWritePhase)).toEqual(['before', 'before', 'after', 'after']);
  });

  it('refuses stale or dirty writes before changing any file', async () => {
    const sourcePath = path.join(root, 'board.tsx');
    await fs.writeFile(sourcePath, 'disk source');
    await expect(service.write(root, {
      label: 'Stale edit', actor: 'agent', changes: [
        { path: sourcePath, expectedSha256: hash('older source'), content: 'agent source' },
      ],
    })).rejects.toBeInstanceOf(ProjectFileConflictError);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('disk source');
    expect(historyCalls).toHaveLength(0);

    dirtyPaths.add(sourcePath);
    await expect(service.write(root, {
      label: 'Dirty edit', actor: 'user', changes: [
        { path: sourcePath, expectedSha256: hash('disk source'), content: 'user source' },
      ],
    })).rejects.toMatchObject({ filePath: sourcePath });
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('disk source');
  });

  it('reverses an edit through a compare-and-swap write of the prior content (editor-owned undo)', async () => {
    await fs.writeFile(path.join(root, 'board.tsx'), 'old');
    // Forward edit: source change + new sidecar, as the editor would issue it.
    const applied = await service.write(root, {
      label: 'Move C1', actor: 'user', changes: [
        { path: 'board.tsx', expectedSha256: hash('old'), content: 'new' },
        { path: 'manual-edits.json', expectedSha256: null, content: '{"moved":true}' },
      ],
    });

    // The editor undoes by writing the prior content back, guarded on the post-edit hash —
    // no host-owned undo stack is involved. The created sidecar is reversed with content: null,
    // which deletes it.
    await service.write(root, {
      label: 'Undo Move C1', actor: 'user', changes: [
        { path: 'board.tsx', expectedSha256: applied.files[0].afterSha256, content: 'old' },
        { path: 'manual-edits.json', expectedSha256: applied.files[1].afterSha256, content: null },
      ],
    });
    expect(await fs.readFile(path.join(root, 'board.tsx'), 'utf8')).toBe('old');
    await expect(fs.access(path.join(root, 'manual-edits.json'))).rejects.toThrow();
  });

  it('rolls files back if post-history persistence fails', async () => {
    const secondPath = path.join(root, 'other.tsx');
    await fs.writeFile(secondPath, 'before');
    failHistoryPhase = 'after';
    await expect(service.write(root, {
      label: 'History failure', actor: 'user', changes: [
        { path: secondPath, expectedSha256: hash('before'), content: 'after' },
      ],
    })).rejects.toThrow('history failed');
    expect(await fs.readFile(secondPath, 'utf8')).toBe('before');
    expect(historyCalls.at(-1)?.metadata.projectWritePhase).toBe('rollback');
  });

  // Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege for this filesystem security case.
  it.skipIf(process.platform === 'win32')('keys dirty checks and receipt paths on the caller root spelling, not the realpath', async () => {
    // A workspace opened through a symlinked path (common on macOS: /tmp -> /private/tmp)
    // must still line up with the renderer's non-canonical filePath and dirty-registry keys.
    const realDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-project-real-')));
    const linkRoot = path.join(realDir, '..', `nimbalyst-project-link-${randomUUID()}`);
    await fs.symlink(realDir, linkRoot);
    try {
      await fs.writeFile(path.join(realDir, 'board.tsx'), 'old source');

      // read echoes the caller's (symlinked) root spelling.
      const [snapshot] = await service.read(linkRoot, ['board.tsx']);
      expect(snapshot.path).toBe(path.join(linkRoot, 'board.tsx'));

      // The dirty guard must match on that same logical path, not the realpath.
      dirtyPaths.add(path.join(linkRoot, 'board.tsx'));
      await expect(service.write(linkRoot, {
        label: 'Edit through symlinked root', actor: 'user', changes: [
          { path: 'board.tsx', expectedSha256: hash('old source'), content: 'new source' },
        ],
      })).rejects.toBeInstanceOf(ProjectFileConflictError);
      expect(await fs.readFile(path.join(realDir, 'board.tsx'), 'utf8')).toBe('old source');

      // With the editor clean, the write applies and the receipt carries the caller spelling.
      dirtyPaths.clear();
      const receipt = await service.write(linkRoot, {
        label: 'Edit through symlinked root', actor: 'user', changes: [
          { path: 'board.tsx', expectedSha256: hash('old source'), content: 'new source' },
        ],
      });
      expect(receipt.files[0].path).toBe(path.join(linkRoot, 'board.tsx'));
      expect(await fs.readFile(path.join(realDir, 'board.tsx'), 'utf8')).toBe('new source');
    } finally {
      await fs.rm(linkRoot, { force: true });
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });

  // Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege for this filesystem security case.
  it.skipIf(process.platform === 'win32')('rejects workspace escape and symlink escape', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-project-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'escape'));
      await expect(service.read(root, ['../outside.txt'])).rejects.toThrow('escapes the workspace');
      await expect(service.read(root, ['escape/secret.txt'])).rejects.toThrow('escapes the workspace');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
