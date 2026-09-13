import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export function preservedClaudeFiles(dir: string, binaryName: string): string[] {
  try {
    const prefix = `${binaryName}.old.`;
    return fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => {
        const first = BigInt(a.slice(prefix.length));
        const second = BigInt(b.slice(prefix.length));
        return first > second ? -1 : first < second ? 1 : 0;
      })
      .map(name => path.join(dir, name))
      .filter(file => {
        try { return fs.lstatSync(file).isFile(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

/** #1476: never execute an orphan to decide whether its bytes are trusted. */
export function recoverClaudeRuntime(options: {
  legacyDir: string;
  destination: string;
  manifestPath: string;
  platformKey: string;
  binaryName: string;
}): boolean {
  const { destination, legacyDir, manifestPath, platformKey, binaryName } = options;
  // lstat also detects dangling symlinks, which must not be overwritten.
  const destinationExists = () => {
    try { fs.lstatSync(destination); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    if (destinationExists()) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const expected = manifest?.platforms?.[platformKey];
    if (!expected || expected.binary !== binaryName || !Number.isSafeInteger(expected.size) ||
        expected.size <= 0 || typeof expected.checksum !== 'string' || !/^[a-f\d]{64}$/i.test(expected.checksum)) return false;

    for (const candidate of preservedClaudeFiles(legacyDir, binaryName)) {
      let fd: number | undefined;
      try {
        const before = fs.lstatSync(candidate);
        if (!before.isFile() || before.size !== expected.size) continue;
        fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) continue;
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytes = 0;
        let count: number;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          bytes += count;
          if (bytes > expected.size) break;
          hash.update(buffer.subarray(0, count));
        }
        if (bytes !== expected.size || hash.digest('hex') !== expected.checksum.toLowerCase()) continue;
        const after = fs.lstatSync(candidate);
        if (!after.isFile() || after.ino !== opened.ino || after.dev !== opened.dev ||
            after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) continue;
        fs.closeSync(fd);
        fd = undefined;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (destinationExists()) return false;
        // rename overwrites on POSIX. A same-volume hard link publishes the
        // verified file atomically with EEXIST semantics; unlink only after success.
        console.warn('[Claude runtime] #1476: publishing manifest-verified self-update recovery');
        fs.linkSync(candidate, destination);
        fs.unlinkSync(candidate);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        // Preserve rejected/unreadable candidates and try the next pinned copy.
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  } catch {
    // Missing/malformed manifest or unwritable resources: fail closed.
  }
  return false;
}
