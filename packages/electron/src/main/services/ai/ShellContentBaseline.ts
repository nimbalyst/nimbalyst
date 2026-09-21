import fs from 'node:fs/promises';
import path from 'node:path';
import { contentFingerprint } from '../../file/knownFileWrites';
import type { CheckoutCandidate } from './ShellCheckoutBaseline';

type Git = (cwd: string, args: string[]) => Promise<string>;
export const SHELL_BASELINE_CAPTURE_MS = 1250;

/** Pin clean files to an immutable revision; hash only already-dirty/untracked files. */
export async function prepareShellContentBaseline(root: string, captureGit: Git, git: Git = captureGit) {
  const revision = await captureGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(value => value.trim(), error => {
    if (error.code === 1) return undefined; // An unborn repository has no clean tracked baseline.
    throw error;
  });
  const [dirty, untracked] = await Promise.all([
    revision ? captureGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', revision, '--']) : captureGit(root, ['ls-files', '--cached', '-z']),
    captureGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  // No hard cap here: paths past the fingerprint budget abstain individually
  // below, whereas throwing turned a large untracked tree into a fault on every command.
  const paths = [...new Set((dirty + untracked).split('\0').filter(Boolean))];
  const before = new Map<string, string | null | undefined>();
  let bytes = 0;
  const fingerprint = async (relative: string) => {
    const file = path.join(root, relative);
    try {
      const stat = await fs.lstat(file);
      // Git submodules, symlinks and special files cannot supply a byte baseline.
      if (!stat.isFile()) return undefined;
      if (bytes + stat.size > 64 * 1024 * 1024) return undefined;
      bytes += stat.size;
      return contentFingerprint(await fs.readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  // Large unrelated dirty files must not disable every tool in the workspace.
  // Uncaptured paths abstain individually if this command later touches them.
  for (const file of paths.slice(512)) before.set(file, undefined);
  for (let start = 0; start < Math.min(paths.length, 512); start += 16)
    await Promise.all(paths.slice(start, start + 16).map(async file => before.set(file, await fingerprint(file))));
  return async (candidates: CheckoutCandidate[], observedRoot = root): Promise<Map<string, 'edit' | 'unchanged'>> => {
    const [tree, diff] = await Promise.all([
      revision ? git(root, ['ls-tree', '-r', '--name-only', '-z', revision]) : Promise.resolve(''),
      revision ? git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', revision, '--']) : Promise.resolve(''),
    ]);
    const tracked = new Set(tree.split('\0').filter(Boolean));
    if (tracked.size > 100_000) throw new Error('Content tree exceeds tracking capacity');
    const changed = new Set(diff.split('\0').filter(Boolean));
    const results = new Map<string, 'edit' | 'unchanged'>();
    bytes = 0;
    for (const candidate of candidates) {
      const relative = path.relative(observedRoot, candidate.filePath).split(path.sep).join('/');
      const after = await fingerprint(relative);
      if (after === undefined || (before.has(relative) && before.get(relative) === undefined)) continue;
      const unchanged = before.has(relative) ? before.get(relative) === after : tracked.has(relative) && !changed.has(relative);
      // An identical final file is a no-op even if callbacks saw a transient
      // deletion/rewrite. Otherwise retain only stable, frozen tool evidence.
      if (unchanged) results.set(candidate.filePath, 'unchanged');
      else if (after === candidate.fingerprint) results.set(candidate.filePath, 'edit');
    }
    return results;
  };
}
