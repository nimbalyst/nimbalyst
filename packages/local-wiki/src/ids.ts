import { createHash, getRandomValues } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48-bit millisecond time, 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = getRandomValues(new Uint8Array(16));
  let random = '';
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i] % 32];
  return time + random;
}

/** Content version: a short sha256 of the text. */
export function contentVersion(text: string): string {
  return 'h' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 20);
}

/**
 * Id for something that has nowhere to store one (a bare folder, a malformed
 * file, a file read without repair). Stable while the path does not change.
 */
export function derivedId(prefix: 'dir' | 'bad' | 'tmp' | 'dup', relPath: string): string {
  const digest = createHash('sha256').update(relPath, 'utf8').digest();
  let out = '';
  for (let i = 0; i < 20; i++) out += CROCKFORD[digest[i] % 32];
  return `${prefix}_${out}`;
}

export function isDerivedId(id: string): boolean {
  return /^(dir|bad|tmp|dup)_/.test(id);
}

/**
 * An id that cannot name a path: letters, digits, `_` and `-`, with at most one
 * `prefix:` namespace (`type-page:<typeId>`, `table:<typeId>`). Every id the
 * library reads or is given must pass.
 */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/.test(id);
}

/** An id as it appears in a file name (`:` is not allowed on Windows). */
export function idForFileName(id: string): string {
  return id.replace(/:/g, '_');
}
