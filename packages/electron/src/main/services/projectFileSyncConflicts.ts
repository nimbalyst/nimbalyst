import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Keep the remote copy of a file the conflict guard is about to refuse, when
 * both sides moved off the last agreed content. The guard keeps local and
 * re-pushes it, which replaces the remote version on every device, so without
 * this a concurrent edit from another device would be lost silently. A remote
 * copy that still matches the baseline is only stale and is not kept.
 *
 * The copy is an ordinary workspace file next to the original, so it syncs
 * like any other. Returns its path, or null when nothing was kept.
 */
export async function keepDivergedRemoteCopy(
  filePath: string,
  remote: { content: string; contentHash: string },
  localHash: string,
  baselineHash: string | undefined,
  now = new Date(),
): Promise<string | null> {
  if (!baselineHash || localHash === baselineHash || remote.contentHash === baselineHash) return null;
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  const base = path.join(path.dirname(filePath), `${path.basename(filePath, '.md')} (conflict ${stamp})`);
  for (let n = 1; ; n++) {
    const copyPath = `${base}${n > 1 ? ` ${n}` : ''}.md`;
    try {
      await fs.writeFile(copyPath, remote.content, { encoding: 'utf-8', flag: 'wx' });
      logger.main.warn(`[ProjectFileSync] Both sides changed ${path.basename(filePath)}; kept the remote version as ${path.basename(copyPath)}`);
      return copyPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}
