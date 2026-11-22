// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneCpuProfiles } from '../cpuProfileRetention';

const now = Date.parse('2026-10-24T19:00:00Z');
const minute = 60_000;
const day = 24 * 60 * minute;
const dirs: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpu-retention-'));
  dirs.push(dir);
  return dir;
}
async function profile(dir: string, age: number, prefix = 'cpu', size = 10) {
  const name = `${prefix}-${new Date(now - age).toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
  const file = path.join(dir, name);
  await fs.writeFile(file, '');
  await fs.truncate(file, size);
  await fs.utimes(file, new Date(now - age), new Date(now - age));
  return name;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('CPU profile retention', () => {
  it('keeps the newest 100 across all three producers', async () => {
    const dir = await directory();
    const names = [];
    for (let i = 0; i < 103; i++) {
      names.push(await profile(dir, (i + 2) * minute, ['cpu', 'cpu-sqlite-worker', 'cpu-pglite-worker'][i % 3]));
    }
    expect(await pruneCpuProfiles(dir, now)).toEqual({ deletedCount: 3, deletedBytes: 30 });
    expect((await fs.readdir(dir)).sort()).toEqual(names.slice(0, 100).sort());
  });

  it('expires profiles after seven days, preserving logs, custom names, directories and symlinks', async () => {
    const dir = await directory();
    await profile(dir, 8 * day);
    const retained = await profile(dir, 7 * day);
    const untouched = ['main.log', 'incident.cpuprofile', 'cpu-custom.cpuprofile', 'cpu-2026-01-01T00-00-00-000Z.cpuprofile.partial'];
    for (const name of untouched) await fs.writeFile(path.join(dir, name), 'evidence');
    const link = 'cpu-2026-01-01T00-00-00-000Z.cpuprofile';
    await fs.symlink(path.join(dir, 'main.log'), path.join(dir, link));
    const subdir = 'cpu-2026-01-02T00-00-00-000Z.cpuprofile';
    await fs.mkdir(path.join(dir, subdir));
    expect(await pruneCpuProfiles(dir, now)).toEqual({ deletedCount: 1, deletedBytes: 10 });
    expect((await fs.readdir(dir)).sort()).toEqual([...untouched, retained, link, subdir].sort());
    expect(await fs.readFile(path.join(dir, 'main.log'), 'utf8')).toBe('evidence');
  });

  it('bounds total bytes by removing the oldest profiles first', async () => {
    const dir = await directory();
    const retained = await profile(dir, 2 * minute, 'cpu', 60 * 1024 * 1024);
    await profile(dir, 3 * minute, 'cpu-sqlite-worker', 60 * 1024 * 1024);
    expect(await pruneCpuProfiles(dir, now)).toEqual({ deletedCount: 1, deletedBytes: 60 * 1024 * 1024 });
    expect(await fs.readdir(dir)).toEqual([retained]);
  });

  it('protects a recent write even when oversized, then prunes it after the grace period', async () => {
    const dir = await directory();
    const name = await profile(dir, 0, 'cpu-pglite-worker', 101 * 1024 * 1024);
    expect(await pruneCpuProfiles(dir, now)).toEqual({ deletedCount: 0, deletedBytes: 0 });
    expect(await fs.readdir(dir)).toEqual([name]);
    expect(await pruneCpuProfiles(dir, now + minute)).toEqual({ deletedCount: 1, deletedBytes: 101 * 1024 * 1024 });
  });

  it('tolerates a missing directory and overlapping cleanup passes', async () => {
    const dir = await directory();
    expect(await pruneCpuProfiles(path.join(dir, 'missing'), now)).toEqual({ deletedCount: 0, deletedBytes: 0 });
    await profile(dir, 8 * day);
    const results = await Promise.all([pruneCpuProfiles(dir, now), pruneCpuProfiles(dir, now)]);
    // Concurrent unlink calls can both succeed on macOS; either outcome is safe.
    expect(results.every(result => result.deletedCount <= 1)).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('leaves a profile that changed between enumeration and deletion for the next pass', async () => {
    const dir = await directory();
    const name = await profile(dir, 8 * day);
    const originalLstat = fs.lstat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (++calls === 2) await fs.utimes(path.join(dir, name), new Date(now), new Date(now));
      return originalLstat(...args);
    });
    expect(await pruneCpuProfiles(dir, now)).toEqual({ deletedCount: 0, deletedBytes: 0 });
    expect(await fs.readdir(dir)).toEqual([name]);
  });
});
