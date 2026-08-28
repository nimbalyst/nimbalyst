import { describe, it, expect, vi } from 'vitest';
import { sep } from 'path';
import { registerSessionWorktreeAssetRoot } from '../nimAssetWorktreeRoots';
import { validateNimAssetPath } from '../nimAssetProtocol';

const WS = `${sep}dev${sep}Foo`;
const WORKTREE = `${sep}dev${sep}Foo_worktrees${sep}bar`;

function deps(dirExists: (path: string) => boolean = () => true) {
  return {
    addRoot: vi.fn<(absolutePath: string) => void>(),
    dirExists,
    logWarn: vi.fn<(message: string) => void>(),
  };
}

describe('registerSessionWorktreeAssetRoot (#1343)', () => {
  it('registers the worktree directory for a worktree session', () => {
    const d = deps();
    expect(registerSessionWorktreeAssetRoot({ worktreePath: WORKTREE }, d)).toBe(WORKTREE);
    expect(d.addRoot).toHaveBeenCalledWith(WORKTREE);
  });

  // The control that must go the other way: a plain session has no worktree,
  // so nothing new may be allowed. If this ever registers, the fix has widened
  // the protocol for every session rather than for worktree sessions.
  it.each([
    ['no worktreePath key', {}],
    ['null worktreePath', { worktreePath: null }],
    ['empty worktreePath', { worktreePath: '' }],
    ['null session', null],
    ['undefined session', undefined],
  ])('registers nothing for %s', (_label, session) => {
    const d = deps();
    expect(registerSessionWorktreeAssetRoot(session as any, d)).toBeNull();
    expect(d.addRoot).not.toHaveBeenCalled();
  });

  it('refuses a relative path, which would resolve against the main process cwd', () => {
    const d = deps();
    expect(registerSessionWorktreeAssetRoot({ worktreePath: 'Foo_worktrees/bar' }, d)).toBeNull();
    expect(d.addRoot).not.toHaveBeenCalled();
    expect(d.logWarn).toHaveBeenCalled();
  });

  it('refuses a stale record whose directory is gone', () => {
    const d = deps(() => false);
    expect(registerSessionWorktreeAssetRoot({ worktreePath: WORKTREE }, d)).toBeNull();
    expect(d.addRoot).not.toHaveBeenCalled();
    expect(d.logWarn).toHaveBeenCalled();
  });

  it('is safe to call on every turn', () => {
    const d = deps();
    for (let i = 0; i < 3; i++) registerSessionWorktreeAssetRoot({ worktreePath: WORKTREE }, d);
    expect(d.addRoot).toHaveBeenCalledTimes(3);
    expect(new Set(d.addRoot.mock.calls.map(([p]) => p)).size).toBe(1);
  });
});

/**
 * The question the unit tests above do not answer: after registering, can the
 * image actually be served? The reporter's symptom is a 403 from
 * `validateNimAssetPath`, so that is what has to change.
 */
describe('a registered worktree root makes the image servable (#1343)', () => {
  const image = `${WORKTREE}${sep}.screenshots${sep}shot.png`;

  it('is rejected when only the workspace root is allowed -- the bug', () => {
    expect(validateNimAssetPath(image, [WS])).toBeNull();
  });

  it('is accepted once the worktree root is registered -- the fix', () => {
    const roots: string[] = [WS];
    registerSessionWorktreeAssetRoot(
      { worktreePath: WORKTREE },
      { addRoot: (p) => roots.push(p), dirExists: () => true },
    );
    expect(validateNimAssetPath(image, roots)).toBe(image);
  });

  it('still rejects a sibling directory that merely shares the prefix', () => {
    // `<ws>_worktrees/bar-evil` starts with the same characters as the
    // registered root; only a separator-aware check keeps it out.
    const roots: string[] = [WS];
    registerSessionWorktreeAssetRoot(
      { worktreePath: WORKTREE },
      { addRoot: (p) => roots.push(p), dirExists: () => true },
    );
    expect(validateNimAssetPath(`${WORKTREE}-evil${sep}shot.png`, roots)).toBeNull();
  });

  it('still rejects a non-image inside the registered worktree', () => {
    const roots: string[] = [WS];
    registerSessionWorktreeAssetRoot(
      { worktreePath: WORKTREE },
      { addRoot: (p) => roots.push(p), dirExists: () => true },
    );
    expect(validateNimAssetPath(`${WORKTREE}${sep}.env`, roots)).toBeNull();
    expect(validateNimAssetPath(`${WORKTREE}${sep}secrets.txt`, roots)).toBeNull();
  });

  it('still rejects traversal out of the registered worktree', () => {
    const roots: string[] = [WS];
    registerSessionWorktreeAssetRoot(
      { worktreePath: WORKTREE },
      { addRoot: (p) => roots.push(p), dirExists: () => true },
    );
    expect(validateNimAssetPath(`${WORKTREE}${sep}..${sep}..${sep}etc${sep}x.png`, roots)).toBeNull();
  });
});
