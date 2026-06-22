/**
 * Cross-process spawn lock for the Antigravity language server.
 *
 * The gemini-antigravity backend module runs once per workspace (the host keys
 * module processes by workspacePath). When the meta-agent spawns child sessions
 * in their own worktrees, several backend module processes start at once. The
 * language server is a shared model endpoint, not a per-workspace resource, so
 * exactly one process should spawn it and the rest should discover and attach.
 * Without a lock, two processes both miss discovery during the spawn window and
 * each launch a server; the pair then share --app_data_dir and the ~/.gemini
 * OAuth and contend until GetModelResponse times out.
 *
 * These are file-lock primitives (an exclusive 'wx' create is atomic across
 * processes). A lock older than staleMs is treated as abandoned (its holder
 * crashed mid-spawn) and stolen.
 */
import * as fs from 'fs';

export interface SpawnLockOptions {
  /** A lock older than this is considered abandoned and is stolen. */
  staleMs?: number;
  /** Bound on internal retries (stale-steal then re-acquire). */
  maxAttempts?: number;
}

/**
 * True if a process with this pid currently exists. process.kill(pid, 0) sends
 * no signal; it just probes existence. EPERM means it exists but we may not
 * signal it, which still counts as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Try to take the lock. Returns true if THIS process now holds it (and must
 * call releaseSpawnLock), false if a live sibling holds it. Never throws: on an
 * unexpected filesystem error it returns true so a flaky FS cannot deadlock the
 * caller.
 */
export async function acquireSpawnLock(
  lockPath: string,
  opts: SpawnLockOptions = {},
): Promise<boolean> {
  const staleMs = opts.staleMs ?? 90_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fh = await fs.promises.open(lockPath, 'wx');
      try {
        await fh.writeFile(`${process.pid}`);
      } finally {
        await fh.close();
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return true; // do not block on unexpected FS errors
      // Lock exists. Steal it if the holder process is dead (crashed mid-spawn)
      // or the lock is older than staleMs (PID reuse / unknown holder fallback).
      try {
        const st = await fs.promises.stat(lockPath);
        const holderPid = await fs.promises
          .readFile(lockPath, 'utf8')
          .then((t) => parseInt(t.trim(), 10))
          .catch(() => NaN);
        const holderDead =
          Number.isFinite(holderPid) && holderPid > 0 && !isProcessAlive(holderPid);
        if (holderDead || Date.now() - st.mtimeMs > staleMs) {
          await fs.promises.unlink(lockPath).catch(() => {});
          continue; // abandoned holder: steal and retry
        }
      } catch {
        continue; // lock vanished between open and stat: retry
      }
      return false; // fresh lock held by a live sibling
    }
  }
  return false;
}

/** Release the lock. Idempotent and safe if the file is already gone. */
export async function releaseSpawnLock(lockPath: string): Promise<void> {
  await fs.promises.unlink(lockPath).catch(() => {});
}
