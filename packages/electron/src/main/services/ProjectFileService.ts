import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProjectFileSnapshot,
  ProjectFileEdit,
  ProjectFileWriteReceipt,
} from '@nimbalyst/runtime';

const MAX_FILES = 32;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_LABEL_BYTES = 256;
const SHA256_RE = /^[a-f0-9]{64}$/;

interface HistorySnapshotWriter {
  createSnapshot(
    filePath: string,
    content: string,
    type: 'manual',
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

interface WriteFileState {
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
}

interface WriteFrame {
  id: string;
  label: string;
  actor: 'user' | 'agent';
  files: WriteFileState[];
}

interface WorkspaceRoots {
  /** The caller's (renderer's) workspace-root spelling. Used for path identity. */
  raw: string;
  /** The realpath-resolved root. Used for symlink-escape checks and lock keying. */
  real: string;
}

export class ProjectFileConflictError extends Error {
  readonly code = 'PROJECT_FILE_CONFLICT';
  constructor(message: string, readonly filePath?: string) {
    super(message);
    this.name = 'ProjectFileConflictError';
  }
}

/**
 * Stateless coordinator for host-backed project-file reads and grouped
 * compare-and-swap writes. It owns NO undo/redo history: a write is a plain
 * filesystem edit recorded in Nimbalyst document history, and the editor that
 * requested it reverses an edit by writing the prior content back.
 */
export class ProjectFileService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly history: HistorySnapshotWriter,
    private readonly isDirty: (filePath: string) => boolean,
  ) {}

  async read(workspaceRoot: string, requestedPaths: string[]): Promise<ProjectFileSnapshot[]> {
    const roots = await this.resolveWorkspaceRoot(workspaceRoot);
    this.assertFileCount(requestedPaths);
    const resolved = await this.resolveUniquePaths(roots, requestedPaths);
    const snapshots: ProjectFileSnapshot[] = [];
    let totalBytes = 0;

    for (const filePath of resolved) {
      const content = await this.readStableUtf8(filePath);
      if (content === null) {
        snapshots.push({ path: filePath, exists: false, content: null, sha256: null });
        continue;
      }
      const bytes = Buffer.byteLength(content);
      totalBytes += bytes;
      this.assertContentBounds(bytes, totalBytes);
      snapshots.push({ path: filePath, exists: true, content, sha256: sha256(content) });
    }

    return snapshots;
  }

  async write(workspaceRoot: string, edit: ProjectFileEdit): Promise<ProjectFileWriteReceipt> {
    return this.withWorkspaceLock(workspaceRoot, async (roots) => {
      this.validateEdit(edit);
      const resolved = await this.resolveUniquePaths(roots, edit.changes.map((change) => change.path));
      const files: WriteFileState[] = [];
      let totalBytes = 0;

      for (let index = 0; index < edit.changes.length; index += 1) {
        const change = edit.changes[index];
        const filePath = resolved[index];
        if (this.isDirty(filePath)) {
          throw new ProjectFileConflictError('An affected file has unsaved editor changes.', filePath);
        }
        const beforeContent = await this.readStableUtf8(filePath);
        const actualHash = beforeContent === null ? null : sha256(beforeContent);
        if (actualHash !== change.expectedSha256) {
          throw new ProjectFileConflictError('An affected file changed after it was read.', filePath);
        }
        if (change.content !== null) {
          const bytes = Buffer.byteLength(change.content);
          totalBytes += bytes;
          this.assertContentBounds(bytes, totalBytes);
        }
        files.push({ path: filePath, beforeContent, afterContent: change.content });
      }

      const frame: WriteFrame = {
        id: randomUUID(),
        label: edit.label.trim(),
        actor: edit.actor,
        files,
      };
      return this.commitFrame(frame);
    });
  }

  private async commitFrame(frame: WriteFrame): Promise<ProjectFileWriteReceipt> {
    await this.writeHistory(frame, 'before');
    const written: WriteFileState[] = [];
    try {
      for (const file of frame.files) {
        await this.writeState(file.path, file.afterContent, file.beforeContent === null);
        written.push(file);
      }
      await this.writeHistory(frame, 'after');
    } catch (error) {
      try {
        for (const file of [...written].reverse()) {
          await this.writeState(file.path, file.beforeContent, false);
        }
        await this.writeHistory(frame, 'rollback');
      } catch (rollbackError) {
        throw new Error(
          `Project file write failed (${String(error)}) and rollback could not restore every file: ${String(rollbackError)}`,
        );
      }
      throw error;
    }

    return {
      id: frame.id,
      label: frame.label,
      actor: frame.actor,
      timestamp: Date.now(),
      files: frame.files.map((file) => ({
        path: file.path,
        beforeSha256: file.beforeContent === null ? null : sha256(file.beforeContent),
        afterSha256: file.afterContent === null ? null : sha256(file.afterContent),
      })),
      atomic: false,
    };
  }

  private async writeHistory(frame: WriteFrame, phase: 'before' | 'after' | 'rollback'): Promise<void> {
    for (const file of frame.files) {
      const content = phase === 'after' ? file.afterContent : file.beforeContent;
      await this.history.createSnapshot(file.path, content ?? '', 'manual', frame.label, {
        projectWriteId: frame.id,
        projectWritePhase: phase,
        projectWriteActor: frame.actor,
        projectWriteFileExists: content !== null,
      });
    }
  }

  private async writeState(filePath: string, content: string | null, requireAbsent: boolean): Promise<void> {
    if (content === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (requireAbsent) {
      await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
      return;
    }
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async readStableUtf8(filePath: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const before = await fs.stat(filePath);
        if (!before.isFile()) throw new Error(`Project file path is not a regular file: ${filePath}`);
        if (before.size > MAX_FILE_BYTES) throw new Error(`Project file exceeds ${MAX_FILE_BYTES} bytes: ${filePath}`);
        const content = await fs.readFile(filePath, 'utf8');
        const after = await fs.stat(filePath);
        if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino) return content;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    throw new ProjectFileConflictError('A file changed while it was being read.', filePath);
  }

  private validateEdit(edit: ProjectFileEdit): void {
    if (!edit || (edit.actor !== 'user' && edit.actor !== 'agent')) throw new Error('Project file edit actor is invalid.');
    const label = edit.label?.trim();
    if (!label || Buffer.byteLength(label) > MAX_LABEL_BYTES) throw new Error('Project file edit label is invalid.');
    this.assertFileCount(edit.changes);
    for (const change of edit.changes) {
      if (change?.content !== null && typeof change?.content !== 'string') {
        throw new Error('Project file content must be UTF-8 text or null to delete.');
      }
      if (change.expectedSha256 !== null && !SHA256_RE.test(change.expectedSha256)) {
        throw new Error('Project file expectedSha256 must be a lowercase SHA-256 hash or null.');
      }
    }
  }

  private assertFileCount(values: unknown[]): void {
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_FILES) {
      throw new Error(`Project file operations require 1-${MAX_FILES} files.`);
    }
  }

  private assertContentBounds(fileBytes: number, totalBytes: number): void {
    if (fileBytes > MAX_FILE_BYTES) throw new Error(`Project file exceeds ${MAX_FILE_BYTES} bytes.`);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Project file write exceeds ${MAX_TOTAL_BYTES} bytes.`);
  }

  private async resolveWorkspaceRoot(workspaceRoot: string): Promise<WorkspaceRoots> {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('Project file workspace root must be absolute.');
    return { raw: path.normalize(workspaceRoot), real: await fs.realpath(workspaceRoot) };
  }

  private async resolveUniquePaths(roots: WorkspaceRoots, requestedPaths: string[]): Promise<string[]> {
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const requestedPath of requestedPaths) {
      if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.includes('\0')) {
        throw new Error('Project file path is invalid.');
      }
      // The logical path preserves the caller's workspace-root spelling so it
      // matches the renderer's open-editor filePath and the dirty-editor
      // registry keys. Symlink-escape protection resolves against the realpath.
      const logicalPath = path.isAbsolute(requestedPath)
        ? path.normalize(requestedPath)
        : path.resolve(roots.raw, requestedPath);
      assertContained(roots.raw, logicalPath);
      const parent = await fs.realpath(path.dirname(logicalPath));
      assertContained(roots.real, parent);
      // Dedupe on the resolved real target so two spellings of the same file
      // (e.g. via an in-workspace symlink) still collide.
      let realIdentity = path.join(parent, path.basename(logicalPath));
      try {
        realIdentity = await fs.realpath(realIdentity);
        assertContained(roots.real, realIdentity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (seen.has(realIdentity)) throw new Error('Project file paths must be unique.');
      seen.add(realIdentity);
      resolved.push(logicalPath);
    }
    return resolved;
  }

  private async withWorkspaceLock<T>(workspaceRoot: string, operation: (roots: WorkspaceRoots) => Promise<T>): Promise<T> {
    const roots = await this.resolveWorkspaceRoot(workspaceRoot);
    const key = roots.real;
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    this.locks.set(key, queued);
    await prior;
    try {
      return await operation(roots);
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Project file path escapes the workspace.');
  }
}
