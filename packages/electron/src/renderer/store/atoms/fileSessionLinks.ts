import { atom } from 'jotai';
import type { FileLink } from '@nimbalyst/runtime/ai/server/types';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { getRelativeWorkspacePath, normalizePath, resolveProjectPath } from '../../../shared/pathUtils';

/** Share invalidation across main-checkout and worktree views of the same file. */
export function fileSessionLinkKey(workspacePath: string, filePath: string): string {
  const relative = getRelativeWorkspacePath(filePath, workspacePath);
  return relative === null ? normalizePath(filePath) : `${normalizePath(resolveProjectPath(workspacePath))}/${relative}`;
}

export const fileSessionLinksRevisionAtom = atomFamily((_fileKey: string) => atom(0));

/** Owned by the central listener; keep only per-file summaries, not edit history. */
export function createFileSessionLinksInvalidator(invalidate: (key: string) => void) {
  const previous = new Map<string, Map<string, string>>();
  return (sessionId: string, files: FileLink[]) => {
    const summaries = new Map<string, { count: number; timestamp: number; source: unknown }>();
    for (const file of files) {
      const path = /^(?:\/|[A-Za-z]:[\\/])/.test(file.filePath)
        ? file.filePath : `${file.workspaceId}/${file.filePath}`;
      const key = fileSessionLinkKey(file.workspaceId, path);
      const entry = summaries.get(key) ?? { count: 0, timestamp: -Infinity, source: undefined };
      entry.count++;
      if (file.timestamp >= entry.timestamp) {
        entry.timestamp = file.timestamp;
        entry.source = file.metadata && 'source' in file.metadata ? file.metadata.source : undefined;
      }
      summaries.set(key, entry);
    }
    const next = new Map([...summaries].map(([key, value]) => [key, JSON.stringify(value)]));
    const before = previous.get(sessionId) ?? new Map<string, string>();
    previous.set(sessionId, next);
    for (const key of new Set([...before.keys(), ...next.keys()])) {
      if (before.get(key) !== next.get(key)) invalidate(key);
    }
  };
}
