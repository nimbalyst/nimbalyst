import { resolve } from 'pathe';

export type AttachmentStagingMode = 'temp' | 'workspace' | 'custom';

export interface StagedAttachmentRecord {
  path: string;
  filename: string;
  mode: AttachmentStagingMode;
}

function normalizePath(filePath: string): string {
  const resolved = resolve(filePath);
  // Check if we are running in a Node environment with process.platform
  const isWin32 = typeof process !== 'undefined' && process.platform === 'win32';
  return isWin32 ? resolved.toLowerCase() : resolved;
}

class StagedAttachmentRegistry {
  private readonly pathsBySession = new Map<string, Map<string, StagedAttachmentRecord>>();

  register(sessionId: string | undefined, record: StagedAttachmentRecord): void {
    if (!sessionId) return;
    const paths = this.pathsBySession.get(sessionId) ?? new Map<string, StagedAttachmentRecord>();
    paths.set(normalizePath(record.path), { ...record, path: resolve(record.path) });
    this.pathsBySession.set(sessionId, paths);
  }

  find(sessionId: string, filePath: string | undefined): StagedAttachmentRecord | null {
    if (!filePath) return null;
    return this.pathsBySession.get(sessionId)?.get(normalizePath(filePath)) ?? null;
  }

  clearSession(sessionId: string): void {
    this.pathsBySession.delete(sessionId);
  }

  resetForTests(): void {
    this.pathsBySession.clear();
  }
}

export const stagedAttachmentRegistry = new StagedAttachmentRegistry();
