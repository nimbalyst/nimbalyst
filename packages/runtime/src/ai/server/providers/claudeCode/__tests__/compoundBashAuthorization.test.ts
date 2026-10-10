// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { authorizeCompoundBashCommand, COMPOUND_PART_WARNING, createCompoundPartPreApprovalCheck } from '../toolAuthorization';
import { hasShellChainingOperators, splitOnShellOperators, stripHeredocs } from '../../../permissions/BashCommandAnalyzer';
import { generateToolPattern } from '../../../permissions/toolPermissionHelpers';

describe('splitOnShellOperators', () => {
  it('keeps a quoted argument containing ; and || as one argument', () => {
    const parts = splitOnShellOperators(
      "grep -l '^seoTitle:' src/*.md | sed 's|src/content/||;s|\\.md$||' > /tmp/out.txt; wc -l < /tmp/out.txt"
    );

    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('src/*.md');
    expect(parts[0]).not.toContain('glob');
    // Re-splitting a part must not find another chain
    expect(hasShellChainingOperators(parts[0])).toBe(false);
    expect(generateToolPattern('Bash', { command: parts[0] })).toBe('Bash(grep:*)');
    expect(generateToolPattern('Bash', { command: parts[1] })).toBe('Bash(wc:*)');
  });

  it('does not split a heredoc body into sub-commands', () => {
    const command = "cat /tmp/a.txt && python3 - <<'EOF'\na = load('x'); b = load('y')\nprint(a, b)\nEOF";

    const parts = splitOnShellOperators(command);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/^python3 -/);
    expect(parts.some(p => p.includes('load'))).toBe(false);
  });

  it('does not treat semicolons inside a lone heredoc as chaining', () => {
    expect(hasShellChainingOperators("python3 - <<'EOF'\na = 1; b = 2\nEOF")).toBe(false);
  });

  it('re-quotes only words that need it, so parts keep the patterns of the plain commands', () => {
    const parts = splitOnShellOperators('npx @playwright/test --grep=a:b && FOO=1 npm test && cd ~/src && echo "a b"');

    expect(parts).toEqual(['npx @playwright/test --grep=a:b', 'FOO=1 npm test', 'cd ~/src', "echo 'a b'"]);
    expect(generateToolPattern('Bash', { command: parts[0] })).toBe(
      generateToolPattern('Bash', { command: 'npx @playwright/test' })
    );
  });
});

describe('stripHeredocs', () => {
  it('keeps lines after a << that is inside a comment or quotes', () => {
    // Neither << starts a heredoc in bash, so the rm line is a real command
    expect(stripHeredocs('git status && ls # <<A\nrm -rf ~/x\nA')).toContain('rm -rf');
    expect(stripHeredocs('echo "<<A" && git status\nrm -rf ~/x\nA')).toContain('rm -rf');
    expect(stripHeredocs("echo '<<A' && git status\nrm -rf ~/x\nA")).toContain('rm -rf');
    expect(stripHeredocs('echo "$(echo "<<A")" && git status\nrm -rf ~/x\nA')).toContain('rm -rf');
  });

  it('strips a real heredoc that follows a quoted <<', () => {
    expect(stripHeredocs('echo "<<A" && cat <<B\nrm -rf ~/x\nB')).toBe('echo "<<A" && cat ');
  });
});

describe('authorizeCompoundBashCommand', () => {
  function deps(approved: string[], answers: Record<string, 'allow' | 'deny'> = {}) {
    return {
      isPartPreApproved: vi.fn(async (pattern: string) => approved.includes(pattern)),
      authorizePart: vi.fn(async (partInput: any) =>
        (answers[partInput.command] ?? 'allow') === 'allow'
          ? { behavior: 'allow' as const, updatedInput: partInput }
          : { behavior: 'deny' as const, message: 'Tool call denied by user' }),
      logSecurity: vi.fn(),
    };
  }

  it('returns null for a simple command', async () => {
    const d = deps([]);
    await expect(authorizeCompoundBashCommand(d, { command: 'ls -la' })).resolves.toBeNull();
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('returns null for a multi-line compound command so the whole command is prompted', async () => {
    const d = deps(['Bash(ls:*)']);
    await expect(authorizeCompoundBashCommand(d, { command: 'ls && echo ok\nrm -rf build' })).resolves.toBeNull();
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('prompts for the whole command when a comment or quoted << hides a line', async () => {
    const d = deps(['Bash(git status:*)', 'Bash(ls:*)', 'Bash(echo:*)']);

    await expect(authorizeCompoundBashCommand(d, { command: 'git status && ls # <<A\nrm -rf ~/x\nA' })).resolves.toBeNull();
    await expect(authorizeCompoundBashCommand(d, { command: 'echo "<<A" && git status\nrm -rf ~/x\nA' })).resolves.toBeNull();
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('allows without prompting when every part is pre-approved', async () => {
    const d = deps(['Bash(git status:*)', 'Bash(ls:*)']);
    const input = { command: 'git status && ls', description: 'x' };

    await expect(authorizeCompoundBashCommand(d, input)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(d.authorizePart).not.toHaveBeenCalled();
  });

  it('prompts only for parts that are not pre-approved, with the compound warning', async () => {
    const d = deps(['Bash(git status:*)']);
    const input = { command: 'git status && npm test', description: 'x' };

    await expect(authorizeCompoundBashCommand(d, input)).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(d.authorizePart).toHaveBeenCalledTimes(1);
    expect(d.authorizePart).toHaveBeenCalledWith({ command: 'npm test', description: 'x' }, [COMPOUND_PART_WARNING]);
  });

  it('denies and stops at the first denied part', async () => {
    const d = deps([], { 'rm -rf build': 'deny' });

    const result = await authorizeCompoundBashCommand(d, { command: 'rm -rf build && npm test' });

    expect(result).toEqual({ behavior: 'deny', message: 'Tool call denied by user' });
    expect(d.authorizePart).toHaveBeenCalledTimes(1);
  });
});

describe('createCompoundPartPreApprovalCheck', () => {
  it('sees Session approvals held by the permission service as well as the provider', async () => {
    const providerSet = new Set(['Bash(ls:*)']);
    const serviceSet = new Set(['Bash(npm test:*)']);
    const settingsChecker = vi.fn(async (_path: string, pattern: string) => pattern === 'Bash(git status:*)');
    const isPreApproved = createCompoundPartPreApprovalCheck(() => [providerSet, serviceSet], settingsChecker, '/ws');

    expect(await isPreApproved('Bash(ls:*)')).toBe(true);
    expect(await isPreApproved('Bash(npm test:*)')).toBe(true);
    expect(await isPreApproved('Bash(git status:*)')).toBe(true);
    expect(await isPreApproved('Bash(rm:*)')).toBe(false);
    expect(settingsChecker).toHaveBeenCalledWith('/ws', 'Bash(rm:*)');
  });
});
