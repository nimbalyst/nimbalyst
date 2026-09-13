import { createHash } from 'node:crypto';
import path from 'node:path';
const writes = new Map<string, { hash?: string; until: number }>();
export function contentFingerprint(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export function markKnownFileWrite(file: string, content?: string): void {
  const key = path.resolve(file);
  writes.delete(key);
  writes.set(key, {
    hash: content === undefined ? undefined : contentFingerprint(content),
    until: Date.now() + 2000,
  });
  if (writes.size > 1000) writes.delete(writes.keys().next().value!);
}
export function isKnownFileWrite(file: string, hash?: string): boolean {
  const key = path.resolve(file),
    entry = writes.get(key);
  if (!entry) return false;
  if (entry.until < Date.now()) {
    writes.delete(key);
    return false;
  }
  return entry.hash === undefined || entry.hash === hash;
}
