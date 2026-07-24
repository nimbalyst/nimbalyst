import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string. Used as the per-chunk dirty check. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
