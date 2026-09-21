import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareShellContentBaseline, SHELL_BASELINE_CAPTURE_MS } from './ShellContentBaseline';
import { contentFingerprint } from '../../file/knownFileWrites';

export interface CheckoutCandidate { filePath: string; fingerprint: string | null }
export interface ShellCheckoutBaseline {
  defer(filePath: string): Promise<boolean>;
  finish(candidates: CheckoutCandidate[]): Promise<Map<string, 'edit' | 'initialization' | 'unchanged'>>;
}

async function git(cwd: string, args: string[], deadline = Date.now() + SHELL_BASELINE_CAPTURE_MS): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`git ${args[0]}: baseline budget exhausted`);
    // Reserve half the remaining budget for one retry, without extending the
    // shared capture deadline across sequential or parallel Git queries.
    const timeout = Math.max(1, Math.floor(remaining / (attempt === 0 ? 2 : 1)));
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const timedOut = failure.code === 'ETIMEDOUT' || (failure.killed && failure.signal === 'SIGTERM');
      if (!timedOut) throw error;
      if (attempt === 0 && Date.now() < deadline) continue;
      throw new Error(`git ${args[0]} timed out (${attempt + 1} attempts): ${failure.message}`);
    }
  }
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Per-tool inventory; Git supplies repository identity, never session ownership. */
export async function prepareShellCheckoutBaseline(workspace: string): Promise<ShellCheckoutBaseline | undefined> {
  const deadline = Date.now() + SHELL_BASELINE_CAPTURE_MS;
  const captureGit = (cwd: string, args: string[]) => git(cwd, args, deadline);
  let inventory: string;
  try { inventory = await captureGit(workspace, ['worktree', 'list', '--porcelain', '-z']); }
  catch (error) {
    if (String((error as { stderr?: string }).stderr ?? error).includes('not a git repository')) return undefined;
    // execFile's error message includes stderr. Other failures must not invent a baseline.
    if (String(error).includes('not a git repository')) return undefined;
    throw error;
  }
  const roots = inventory.split('\0').filter(s => s.startsWith('worktree ')).map(s => path.resolve(s.slice(9)));
  if (roots.length > 256) throw new Error('Worktree inventory exceeds tracking capacity');
  const knownRoots = new Set(await Promise.all(roots.map(async root => {
    try { return await fs.realpath(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return root; throw error; }
  })));
  const canonicalWorkspace = await fs.realpath(workspace);
  const content = new Map<string, Awaited<ReturnType<typeof prepareShellContentBaseline>>>();
  await Promise.all([...knownRoots].filter(root => inside(canonicalWorkspace, root)).map(async root => {
    content.set(root, await prepareShellContentBaseline(root, captureGit, git));
  }));
  const common = await fs.realpath((await captureGit(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const directories = new Map<string, Promise<string | undefined>>();
  const initial = new Map<string, Promise<string | undefined>>();
  const staged = new Map<string, string>();
  const known = new Map<string, Promise<boolean>>();

  const findRoot = (dir: string): Promise<string | undefined> => {
    const cached = directories.get(dir);
    if (cached) return cached;
    if (!inside(workspace, dir)) return Promise.resolve(undefined);
    if (directories.size >= 16_384) throw new Error('Repository discovery exceeds tracking capacity');
    const promise = (async () => {
      try { await fs.lstat(path.join(dir, '.git')); return dir; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return dir === workspace ? undefined : findRoot(path.dirname(dir));
    })();
    directories.set(dir, promise);
    return promise;
  };
  const initialRevision = (root: string): Promise<string | undefined> => {
    let pending = initial.get(root);
    if (!pending) {
      pending = (async () => {
        const rootCommon = await fs.realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
        if (rootCommon !== common) return undefined;
        // The first worktree HEAD reflog entry preserves the checkout revision even
        // when the creating command edits AND commits before watcher delivery.
        const logPath = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'])).trim();
        const file = await fs.open(logPath, 'r');
        try {
          const buffer = Buffer.alloc(4096);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const revision = buffer.subarray(0, bytesRead).toString().match(/^[0-9a-f]{40,64} ([0-9a-f]{40,64}) /)?.[1];
          if (!revision || /^0+$/.test(revision)) throw new Error('Missing worktree initialization revision');
          return revision;
        } finally { await file.close(); }
      })();
      initial.set(root, pending);
    }
    return pending;
  };
  return {
    async defer(filePath) {
      const root = await findRoot(path.dirname(filePath));
      if (!root) return false;
      let existing = known.get(root);
      if (!existing) { existing = fs.realpath(root).then(value => knownRoots.has(value)); known.set(root, existing); }
      if (await existing) {
        const canonical = await fs.realpath(root);
        if (!content.has(canonical)) return false;
        staged.set(filePath, root);
        return true;
      }
      const revision = await initialRevision(root);
      if (!revision) return false; // An unrelated nested repository is not a new worktree.
      staged.set(filePath, root);
      return true;
    },
    async finish(candidates) {
      const result = new Map<string, 'edit' | 'initialization' | 'unchanged'>();
      for (const root of new Set(candidates.map(c => staged.get(c.filePath)).filter((r): r is string => !!r))) {
        const existing = content.get(await fs.realpath(root));
        if (existing) {
          for (const [file, outcome] of await existing(candidates.filter(c => staged.get(c.filePath) === root), root)) result.set(file, outcome);
          continue;
        }
        const revision = await initialRevision(root);
        if (!revision) throw new Error('Lost worktree initialization revision');
        const [tree, diff] = await Promise.all([
          git(root, ['ls-tree', '-r', '--name-only', '-z', revision]),
          git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', revision, '--']),
        ]);
        const tracked = new Set(tree.split('\0').filter(Boolean)), changed = new Set(diff.split('\0').filter(Boolean));
        if (tracked.size > 100_000) throw new Error('Checkout tree exceeds tracking capacity');
        for (const candidate of candidates) {
          if (staged.get(candidate.filePath) !== root) continue;
          let fingerprint: string | null;
          try { fingerprint = contentFingerprint(await fs.readFile(candidate.filePath)); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            fingerprint = null;
          }
          // A competing or late write is not evidence for the original tool.
          if (fingerprint !== candidate.fingerprint) continue;
          const relative = path.relative(root, candidate.filePath).split(path.sep).join('/');
          result.set(candidate.filePath, tracked.has(relative) && !changed.has(relative) ? 'initialization' : 'edit');
        }
      }
      return result;
    },
  };
}
