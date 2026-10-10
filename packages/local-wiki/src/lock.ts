/**
 * The wiki's cross-process write lock (FORMAT.md "Writes and concurrency").
 * A writer creates `.nimbalyst-wiki.lock` in the root with an exclusive open,
 * holds it for one mutation, and removes it. A lock whose holder is gone (its
 * pid is dead on this host, or its mtime has not moved for `staleMs`) is taken
 * over.
 */
import { link, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

export const LOCK_FILE = '.nimbalyst-wiki.lock';

export interface WriteLockOptions {
  /** How long to wait for another writer before giving up. */
  timeoutMs: number;
  /** A lock whose mtime is older than this is abandoned. The holder touches it every `staleMs / 3`. */
  staleMs: number;
}

interface LockData {
  pid: number;
  host: string;
  acquiredAt: number;
  token: string;
}

/** What a stale verdict was based on, so a takeover can tell it moved the same lock. */
interface Observed {
  token: string | null;
  mtimeMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readLock(file: string): Promise<Partial<LockData> | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Partial<LockData>;
    return data && typeof data === 'object' ? data : null;
  } catch {
    // missing, or created but not yet written
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryCreate(file: string, data: LockData): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(data) + '\n', 'utf8');
  } finally {
    await handle.close();
  }
  return true;
}

/** The observation a stale verdict rests on, or null when the lock is live. 'gone' when it vanished meanwhile. */
async function staleLock(file: string, staleMs: number): Promise<Observed | 'gone' | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return 'gone';
  }
  const data = await readLock(file);
  const token = typeof data?.token === 'string' ? data.token : null;
  const deadHolder = data !== null && data.host === hostname() && typeof data.pid === 'number' && !pidAlive(data.pid);
  if (deadHolder || Date.now() - st.mtimeMs > staleMs) return { token, mtimeMs: st.mtimeMs };
  return null;
}

/**
 * Moves a stale lock aside and deletes it. If what was moved is not the lock
 * that was judged stale (another writer took over in between), it is put back.
 */
async function breakLock(file: string, observed: Observed): Promise<void> {
  const aside = `${file}.${randomBytes(4).toString('hex')}.stale`;
  try {
    await rename(file, aside);
  } catch {
    return; // someone else broke it first
  }
  const moved = await readLock(aside);
  const movedToken = typeof moved?.token === 'string' ? moved.token : null;
  const movedMtime = await stat(aside).then((s) => s.mtimeMs, () => -1);
  const same = observed.token !== null ? movedToken === observed.token : movedToken === null && movedMtime === observed.mtimeMs;
  if (!same) await link(aside, file).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

/**
 * Takes the write lock for `root`. Resolves to a release function, or to null
 * when another writer held it for the whole of `timeoutMs`.
 */
export async function acquireWriteLock(root: string, options: WriteLockOptions): Promise<(() => Promise<void>) | null> {
  const file = path.join(root, LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + options.timeoutMs;
  let delay = 5;
  for (;;) {
    if (await tryCreate(file, { pid: process.pid, host: hostname(), acquiredAt: Date.now(), token })) break;
    const stale = await staleLock(file, options.staleMs);
    if (stale === 'gone') continue;
    if (stale) {
      await breakLock(file, stale);
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(delay);
    delay = Math.min(delay * 2, 100);
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(file, now, now).catch(() => undefined);
  }, Math.max(250, Math.floor(options.staleMs / 3)));
  heartbeat.unref?.();
  return async () => {
    clearInterval(heartbeat);
    // Only remove the lock if it is still ours; a takeover means it is not.
    if ((await readLock(file))?.token === token) await unlink(file).catch(() => undefined);
  };
}
