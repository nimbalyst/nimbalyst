// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AgentToolActivityRegistry } from '../agentToolActivity';

function registry() {
  let now = 1_000_000;
  const r = new AgentToolActivityRegistry(() => now);
  return { r, at: () => now, advance: (ms: number) => { now += ms; } };
}

describe('agent tool activity', () => {
  it('reports an exact edit, a possible shell writer, and an idle session distinctly', () => {
    const { r, at, advance } = registry();
    r.declare('claude', '/workspace');
    r.started('claude', 'edit-1', 'Edit', { file_path: '/workspace/a.ts' });
    advance(50);
    expect(r.writerEvidence('claude', '/workspace/a.ts', at())).toBe('edited');
    // Another file during the same edit is not this session's write.
    expect(r.writerEvidence('claude', '/workspace/b.ts', at())).toBe('idle');
    r.finished('claude', 'edit-1');
    r.started('claude', 'bash-1', 'Bash', { command: 'node gen.js' });
    advance(50);
    expect(r.writerEvidence('claude', '/workspace/b.ts', at())).toBe('possible');
    r.finished('claude', 'bash-1');
    advance(10_000);
    expect(r.writerEvidence('claude', '/workspace/b.ts', at())).toBe('idle');
    expect(r.writerEvidence('never-declared', '/workspace/b.ts', at())).toBe('unknown');
  });

  it('does not open windows for read-only tools or subagent spawns', () => {
    const { r, at } = registry();
    r.declare('claude', '/workspace');
    r.started('claude', 'read', 'Read', { file_path: '/workspace/a.ts' });
    r.started('claude', 'grep', 'Grep', { pattern: 'x' });
    r.started('claude', 'task', 'Task', { prompt: 'go' });
    expect(r.writerEvidence('claude', '/workspace/a.ts', at())).toBe('idle');
    expect(r.activeSessions('/workspace/a.ts', at())).toEqual([]);
  });

  it('keeps a backgrounded command open past its acknowledgement until the turn ends', () => {
    const { r, at, advance } = registry();
    r.declare('claude', '/workspace');
    r.started('claude', 'bg', 'Bash', { command: 'pnpm build --watch', run_in_background: true });
    r.finished('claude', 'bg');
    advance(60_000);
    expect(r.writerEvidence('claude', '/workspace/dist/out.js', at())).toBe('possible');
    expect(r.activeSessions('/workspace/dist/out.js', at())).toEqual(['claude']);
    r.endTurn('claude');
    advance(3_000);
    expect(r.writerEvidence('claude', '/workspace/dist/out.js', at())).toBe('idle');
  });

  it('widens the start of windows observed after the tool may have begun', () => {
    const { r, at, advance } = registry();
    r.declare('cli', '/workspace');
    const writeAt = at();
    advance(500);
    r.started('cli', 'bash', 'Bash', { command: 'sed -i s/a/b/ x.ts' }, { approximate: true });
    expect(r.writerEvidence('cli', '/workspace/x.ts', writeAt)).toBe('possible');
    r.declare('hook', '/workspace');
    r.started('hook', 'bash', 'Bash', { command: 'true' });
    expect(r.writerEvidence('hook', '/workspace/x.ts', writeAt)).toBe('idle');
  });

  it('resolves relative edit targets and ignores files outside the session workspace', () => {
    const { r, at } = registry();
    r.declare('claude', '/workspace');
    r.started('claude', 'w', 'Write', { file_path: 'src/new.ts' });
    expect(r.writerEvidence('claude', '/workspace/src/new.ts', at())).toBe('edited');
    expect(r.activeSessions('/other/src/new.ts', at())).toEqual([]);
  });
});
