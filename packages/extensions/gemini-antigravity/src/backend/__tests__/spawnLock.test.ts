import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSpawnLock, releaseSpawnLock } from '../spawnLock';

const cleanup: string[] = [];
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

async function freshLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nim-spawnlock-'));
  cleanup.push(dir);
  return join(dir, 'spawn.lock');
}

describe('spawnLock', () => {
  it('acquires a free lock and blocks a second acquirer until released', async () => {
    const p = await freshLockPath();
    expect(await acquireSpawnLock(p)).toBe(true);
    // A concurrent sibling must NOT get the fresh lock.
    expect(await acquireSpawnLock(p, { maxAttempts: 1 })).toBe(false);
    await releaseSpawnLock(p);
    // Once released it is acquirable again.
    expect(await acquireSpawnLock(p)).toBe(true);
    await releaseSpawnLock(p);
  });

  it('steals a stale lock whose holder crashed mid-spawn', async () => {
    const p = await freshLockPath();
    await writeFile(p, '99999'); // a dead holder's lock
    const old = new Date(Date.now() - 120_000);
    await utimes(p, old, old);
    // staleMs below the lock's age -> stolen and re-acquired.
    expect(await acquireSpawnLock(p, { staleMs: 1_000 })).toBe(true);
    await releaseSpawnLock(p);
  });

  it('does not steal a fresh lock held by a live sibling', async () => {
    const p = await freshLockPath();
    expect(await acquireSpawnLock(p)).toBe(true); // fresh, held by us
    expect(await acquireSpawnLock(p, { staleMs: 90_000, maxAttempts: 1 })).toBe(false);
    await releaseSpawnLock(p);
  });

  it('release is idempotent and safe on a missing lock', async () => {
    const p = await freshLockPath();
    await releaseSpawnLock(p);
    await releaseSpawnLock(p);
    expect(true).toBe(true);
  });

  it('steals immediately when the holder pid is dead, even with a fresh mtime', async () => {
    const p = await freshLockPath();
    // 2147483647 is effectively never a live pid; lock is brand new (fresh mtime).
    await writeFile(p, '2147483647');
    expect(await acquireSpawnLock(p, { staleMs: 600_000 })).toBe(true);
    await releaseSpawnLock(p);
  });
});
