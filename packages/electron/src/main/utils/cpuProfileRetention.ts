import { promises as fs } from 'node:fs';
import path from 'node:path';

// Keep a useful recent incident window without letting minute-by-minute
// automatic captures grow indefinitely. This budget covers all three producers.
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_PROFILES = 100;
const MAX_BYTES = 100 * 1024 * 1024;
// Producers write directly to the final name. Never prune a fresh/active write;
// an oversized fresh capture is reconsidered on the next maintenance pass.
const WRITE_GRACE_MS = 60_000;
const AUTO_PROFILE_NAME = /^cpu-(?:(?:sqlite|pglite)-worker-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.cpuprofile$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Only generated CPU captures are disposable; logs and user-named profiles are not. */
export async function pruneCpuProfiles(logsDir: string, now = Date.now()) {
  const result = { deletedCount: 0, deletedBytes: 0 };
  let entries;
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return result;
    throw error;
  }

  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !AUTO_PROFILE_NAME.test(entry.name)) continue;
    const file = path.join(logsDir, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile()) profiles.push({ file, stat });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  profiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));

  let keptCount = 0;
  let keptBytes = 0;
  for (const { file, stat } of profiles) {
    const age = now - stat.mtimeMs;
    if (age < WRITE_GRACE_MS ||
        (age <= MAX_AGE_MS && keptCount < MAX_PROFILES && keptBytes + stat.size <= MAX_BYTES)) {
      keptCount++;
      keptBytes += stat.size;
      continue;
    }
    try {
      // Another producer or cleanup pass may have touched/replaced the file
      // since enumeration. Leave it for a future pass instead of deleting it.
      const current = await fs.lstat(file);
      if (!current.isFile() || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) continue;
      await fs.unlink(file);
      result.deletedCount++;
      result.deletedBytes += stat.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return result;
}
