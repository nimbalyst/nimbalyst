// @vitest-environment node
import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { ShellFileAttribution, type ShellFileEvidence } from '../ShellFileAttribution';
import { prepareShellCheckoutBaseline } from '../ShellCheckoutBaseline';
import { SHELL_BASELINE_CAPTURE_MS } from '../ShellContentBaseline';
import { contentFingerprint } from '../../../file/knownFileWrites';
import { ShellTrackingCoverage } from '../ShellTrackingCoverage';

type GitExec = (command: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void) => ReturnType<typeof execFile>;

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

it.each(['retry', 'exhausted', 'non-timeout'] as const)('keeps Git attempts inside the capture budget: %s', async mode => {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const realExec = vi.mocked(execFile).getMockImplementation()!;
  const timeouts: number[] = [];
  vi.mocked(execFile).mockImplementation(((_command, _args, options, callback) => {
    timeouts.push(options.timeout!);
    now += mode === 'exhausted' ? SHELL_BASELINE_CAPTURE_MS : options.timeout!;
    callback(Object.assign(new Error(mode === 'non-timeout' ? 'git permission denied' : 'git stalled'), {
      code: mode === 'non-timeout' ? 'EACCES' : 'ETIMEDOUT',
    }), '', '');
    return null!;
  }) as GitExec as typeof execFile);
  try {
    await expect(prepareShellCheckoutBaseline('/workspace')).rejects.toThrow(mode === 'non-timeout' ? 'permission denied' : 'timed out');
    expect(timeouts).toEqual(mode === 'retry' ? [625, 625] : [625]);
    expect(timeouts.reduce((sum, timeout) => sum + timeout, 0)).toBeLessThanOrEqual(SHELL_BASELINE_CAPTURE_MS);
  } finally {
    clock.mockRestore();
    vi.mocked(execFile).mockImplementation(realExec);
  }
});

it('shares one decreasing deadline across inventory, content and common-directory capture', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nim-baseline-budget-')));
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const realExec = vi.mocked(execFile).getMockImplementation()!;
  const timeouts: number[] = [];
  vi.mocked(execFile).mockImplementation(((_command, args, options, callback) => {
    timeouts.push(options.timeout!);
    now += 100;
    const stdout = args[2] === 'worktree' ? `worktree ${root}\0` :
      args.includes('--git-common-dir') ? root : args.includes('HEAD') ? 'a'.repeat(40) : '';
    callback(null, stdout, '');
    return null!;
  }) as GitExec as typeof execFile);
  try {
    expect(await prepareShellCheckoutBaseline(root)).toBeDefined();
    expect(timeouts).toEqual([625, 575, 525, 475, 425]);
  } finally {
    clock.mockRestore();
    vi.mocked(execFile).mockImplementation(realExec);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['inventory', 'content'])('reports a timed-out %s git call and abstains from identical rebuild links', async site => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nim-baseline-timeout-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const file = path.join(root, 'generated.d.ts');
  const persist = vi.fn(async (_e: ShellFileEvidence) => 'persisted' as const);
  const coverage = new ShellTrackingCoverage({ load: async () => undefined, save: async () => {}, notify: () => {} });
  let emit!: (file: string) => void;
  let now = Date.now();
  const service = new ShellFileAttribution({
    subscribe: async (_root, changed) => { emit = changed; return () => {}; },
    prepareCheckout: prepareShellCheckoutBaseline,
    read: async file => ({ fingerprint: contentFingerprint(await fs.readFile(file)), modifiedAt: now }),
    knownWrite: () => false, otherSessions: () => [], persist,
    report: (...args) => coverage.record(...args), now: () => now, settleMs: 0,
  });
  const realExec = vi.mocked(execFile).getMockImplementation()!;
  let generation: string | undefined;
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    expect(await fs.realpath(git('rev-parse', '--show-toplevel').trim())).toBe(root);
    await fs.writeFile(file, 'baseline\n'); git('add', '.'); git('commit', '-qm', 'baseline');
    vi.mocked(execFile).mockImplementation(((command, args, options, callback) => {
      if (args[2] === (site === 'inventory' ? 'worktree' : 'rev-parse')) {
        callback(Object.assign(new Error('git capture timed out: injected load'), { killed: true, signal: 'SIGTERM' }), '', '');
        return null!;
      }
      return (realExec as GitExec)(command, args, options, callback);
    }) as GitExec as typeof execFile);
    generation = await service.register('writer', root);
    await coverage.open('writer', generation);
    await service.pre(generation, 'rebuild', 'Bash');
    now++;
    await fs.unlink(file); await fs.writeFile(file, 'baseline\n'); emit(file);
    await service.completed(generation, 'rebuild');
    expect(persist).not.toHaveBeenCalled();
    expect((await coverage.readMany(['writer']))[0].events).toContainEqual(expect.objectContaining({
      reason: 'checkoutBaseline', toolUseId: 'rebuild', tool: 'Bash',
      error: expect.stringContaining('git capture timed out: injected load'),
    }));
    // Failure is command-local; a transient timeout on the next capture retries
    // successfully, and reconciliation remains usable after its deadline passes.
    vi.mocked(execFile).mockImplementation(realExec);
    vi.mocked(execFile).mockImplementationOnce(((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('transient timeout'), { killed: true, signal: 'SIGTERM' }), '', '');
      return null!;
    }) as GitExec as typeof execFile);
    await service.pre(generation, 'edit', 'Bash');
    now++; await fs.writeFile(file, 'authored\n'); emit(file);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SHELL_BASELINE_CAPTURE_MS + 1);
    try { await service.completed(generation, 'edit'); }
    finally { later.mockRestore(); }
    expect(persist.mock.calls.map(([e]) => e.toolUseId)).toEqual(['edit']);
  } finally {
    vi.mocked(execFile).mockImplementation(realExec);
    if (generation) await service.release(generation);
    await coverage.flush(['writer']);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('excludes checkout copies but retains edits committed by the creating tool and subsequent shell edits', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-checkout-regression-'));
  const root = await fs.realpath(temp), nested = path.join(root, 'scratch', 'checkout');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const links: ShellFileEvidence[] = [];
  let emit!: (file: string) => void;
  let now = Date.now();
  const service = new ShellFileAttribution({
    subscribe: async (_root: string, changed: (file: string) => void) => { emit = changed; return () => {}; },
    prepareCheckout: prepareShellCheckoutBaseline,
    read: async (file: string) => {
      try { return { fingerprint: contentFingerprint(await fs.readFile(file)), modifiedAt: now }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    knownWrite: () => false,
    otherSessions: () => [],
    persist: async (e: ShellFileEvidence) => { links.push(e); return 'persisted' as const; },
    now: () => now,
    settleMs: 0,
  });
  let generation: string | undefined;
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'user.name', 'Fixture');
    expect(await fs.realpath(git(root, 'rev-parse', '--show-toplevel').trim())).toBe(root);
    await fs.mkdir(path.join(root, '.claude'));
    await fs.writeFile(path.join(root, '.claude', 'unchanged.md'), 'checkout\n');
    await fs.writeFile(path.join(root, 'edited.md'), 'baseline\n');
    await fs.writeFile(path.join(root, 'deleted.md'), 'baseline\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
    generation = await service.register('writer', root);
    await service.pre(generation, 'create-and-edit', 'Bash');
    git(root, 'worktree', 'add', '-q', '-b', 'fixture', nested);
    expect(await fs.realpath(git(nested, 'rev-parse', '--show-toplevel').trim())).toBe(nested);
    // The filesystem can deliver after the command has already committed.
    await fs.writeFile(path.join(nested, 'edited.md'), 'authored\n');
    await fs.unlink(path.join(nested, 'deleted.md'));
    git(nested, 'add', '-u'); git(nested, 'commit', '-qm', 'authored');
    now++;
    emit(path.join(nested, '.claude', 'unchanged.md'));
    emit(path.join(nested, 'edited.md'));
    emit(path.join(nested, 'deleted.md'));
    await service.flush();
    expect(links).toEqual([]); // New-root candidates must wait for checkout reconciliation.
    await service.completed(generation, 'create-and-edit');
    expect(links.map(e => path.relative(nested, e.filePath))).toEqual(['edited.md', 'deleted.md']);
    await service.pre(generation, 'later-edit', 'Bash');
    now++;
    await fs.writeFile(path.join(nested, '.claude', 'unchanged.md'), 'real later edit\n');
    emit(path.join(nested, '.claude', 'unchanged.md'));
    await service.completed(generation, 'later-edit');
    expect(links.map(e => e.toolUseId)).toEqual(['create-and-edit', 'create-and-edit', 'later-edit']);
  } finally {
    if (generation) await service.release(generation);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['alone', 'external session', 'overlapping shell'])('ignores cold-cache identical rebuilds with %s while retaining real change evidence', async mode => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-rebuild-regression-'));
  const root = await fs.realpath(temp);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const links: ShellFileEvidence[] = [];
  let emit!: (file: string) => void;
  let now = Date.now();
  const report = vi.fn();
  const service = new ShellFileAttribution({
    subscribe: async (_root, changed) => { emit = changed; return () => {}; },
    prepareCheckout: prepareShellCheckoutBaseline,
    read: async file => {
      try { return { fingerprint: contentFingerprint(await fs.readFile(file)), modifiedAt: now }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    knownWrite: () => false, otherSessions: () => mode === 'external session' ? ['external'] : [],
    report,
    persist: async e => { links.push(e); return 'persisted'; },
    now: () => now, settleMs: 0,
  });
  let generation: string | undefined;
  let other: string | undefined;
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    expect(await fs.realpath(git('rev-parse', '--show-toplevel').trim())).toBe(root);
    for (const file of ['generated.d.ts', 'dirty.ts', 'revert.ts', 'committed.ts', 'deleted.ts']) await fs.writeFile(path.join(root, file), 'baseline\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    await fs.writeFile(path.join(root, 'dirty.ts'), 'existing dirty content\n');
    await fs.writeFile(path.join(root, 'revert.ts'), 'existing dirty content\n');
    // An unrelated oversized untracked artifact must not disable the baseline.
    const large = await fs.open(path.join(root, 'large-artifact.bin'), 'w');
    await large.truncate(65 * 1024 * 1024); await large.close();
    generation = await service.register('writer', root);
    await service.pre(generation, 'rebuild', 'Bash');
    if (mode === 'overlapping shell') {
      other = await service.register('other', root);
      await service.pre(other, 'other-command', 'Bash');
    }
    now++;
    await fs.unlink(path.join(root, 'generated.d.ts')); emit(path.join(root, 'generated.d.ts'));
    await service.flush();
    for (const [file, text] of [['generated.d.ts', 'baseline\n'], ['dirty.ts', 'existing dirty content\n']]) {
      await fs.writeFile(path.join(root, file), text); emit(path.join(root, file));
    }
    await service.completed(generation, 'rebuild');
    if (other) await service.completed(other, 'other-command');
    expect(links).toEqual([]);
    // A concurrent agent session is noted, never a fault; nothing else may report.
    const reasons = () => new Set(report.mock.calls.map(([, reason]) => reason));
    expect([...reasons()]).toEqual(mode === 'external session' ? ['uninstrumented'] : []);
    await service.pre(generation, 'authored', 'Bash');
    if (other) await service.pre(other, 'other-authored', 'Bash');
    now++;
    for (const [file, text] of [['dirty.ts', 'authored\n'], ['revert.ts', 'baseline\n'], ['committed.ts', 'committed edit\n']]) {
      await fs.writeFile(path.join(root, file), text); emit(path.join(root, file));
    }
    await fs.unlink(path.join(root, 'deleted.ts')); emit(path.join(root, 'deleted.ts'));
    if (other) {
      await service.completed(other, 'other-authored');
      now++;
      await fs.writeFile(path.join(root, 'dirty.ts'), 'later write after the competing tool exits\n');
      emit(path.join(root, 'dirty.ts'));
    }
    git('add', '-u'); git('commit', '-qm', 'authored');
    await service.completed(generation, 'authored');
    if (mode === 'overlapping shell') {
      expect(links).toEqual([]);
      expect(reasons()).toContain('competingOwners');
    } else {
      // Another agent's turn in the workspace shares the link instead of withholding it.
      expect(links.map(e => path.basename(e.filePath)).sort()).toEqual(['committed.ts', 'deleted.ts', 'dirty.ts', 'revert.ts']);
      expect([...reasons()]).toEqual(mode === 'external session' ? ['uninstrumented'] : []);
    }
  } finally {
    if (generation) await service.release(generation);
    if (other) await service.release(other);
    await fs.rm(root, { recursive: true, force: true });
  }
});
