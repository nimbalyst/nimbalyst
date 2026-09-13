// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ShellFileAttribution, type ShellFileState, type ShellFileEvidence } from '../ShellFileAttribution';

function fixture() {
  let now = 1000;
  let emit: (file: string) => void = () => {};
  const state = new Map<string, ShellFileState>();
  const known = new Map<string, string>();
  const persist = vi.fn(async (_e: ShellFileEvidence) => {});
  const unsubscribe = vi.fn();
  const service = new ShellFileAttribution({
    subscribe: async (_w, fn) => {
      emit = fn;
      return unsubscribe;
    },
    read: async (f) => state.get(f) ?? null,
    knownWrite: (f, s) => known.has(f) && known.get(f) === s?.fingerprint,
    otherSessions: () => [],
    persist,
    now: () => now,
    settleMs: 0,
  });
  return {
    service,
    persist,
    known,
    unsubscribe,
    write: (file: string, fingerprint: string) => {
      now++;
      state.set(file, { fingerprint, modifiedAt: now });
      emit(file);
    },
    event: (file: string) => emit(file),
    advance: () => now++,
  };
}
describe('shell hook attribution', () => {
  it('records sequential owners without using a dirty Git baseline or inventing a diff', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    f.write('/workspace/shared.ts', 'pre-dirty');
    await f.service.flush();
    await f.service.pre(a, 'read', 'Bash');
    f.event('/workspace/shared.ts');
    await f.service.post(a, 'read');
    expect(f.persist).not.toHaveBeenCalled();
    await f.service.pre(a, 'one', 'Bash');
    f.write('/workspace/shared.ts', 'A');
    await f.service.post(a, 'one');
    await f.service.pre(b, 'two', 'Bash');
    f.write('/workspace/shared.ts', 'B');
    await f.service.post(b, 'two');
    expect(f.persist.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({
        sessionId: 'A',
        toolUseId: 'one',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
      expect.objectContaining({
        sessionId: 'B',
        toolUseId: 'two',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
    ]);
    await f.service.release(a);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await f.service.release(b);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('captures ambiguity at event arrival and suppresses known saves and structured tools', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    await f.service.pre(a, 'reader', 'Bash');
    await f.service.pre(b, 'writer', 'Bash');
    f.write('/workspace/b.ts', 'B');
    await f.service.post(b, 'writer');
    await f.service.post(a, 'reader');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.service.getStats().ambiguous).toBe(1);
    await f.service.pre(a, 'shell', 'Bash');
    f.known.set('/workspace/edit.ts', 'editor');
    f.write('/workspace/edit.ts', 'editor');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    f.write('/workspace/edit.ts', 'agent-after-save');
    await f.service.flush();
    expect(f.persist).toHaveBeenCalledTimes(1);
    await f.service.pre(b, 'patch', 'apply_patch');
    f.write('/workspace/patch.ts', 'patch');
    await f.service.post(b, 'patch');
    await f.service.post(a, 'shell');
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it('ignores released generations and never credits outside-workspace paths', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'old', 'Bash');
    await f.service.release(a);
    await f.service.pre(a, 'late', 'Bash');
    f.write('/workspace/late.ts', 'late');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    const b = await f.service.register('B', '/workspace');
    await f.service.pre(b, 'new', 'Bash');
    f.write('/workspace-other/file.ts', 'outside');
    await f.service.post(b, 'new');
    expect(f.persist).not.toHaveBeenCalled();
  });
});

it('abstains after registry overflow until turn cleanup and ignores events between turns', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace');
  for (let i = 0; i < 257; i++) await f.service.pre(a, String(i), 'Bash');
  f.write('/workspace/overflow.ts', 'dropped');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  f.service.endTurn(a);
  f.write('/workspace/late.ts', 'late');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.pre(a, 'next', 'Bash');
  f.write('/workspace/next.ts', 'next');
  await f.service.post(a, 'next');
  expect(f.persist).toHaveBeenCalledTimes(1);
  await f.service.release(a);
});

it('keeps an overlapping event ambiguous when one candidate exits before the queued read', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace'),
    b = await f.service.register('B', '/workspace');
  await f.service.pre(a, 'one', 'Bash');
  await f.service.pre(b, 'two', 'Bash');
  f.write('/workspace/mixed.ts', 'B');
  await f.service.release(b);
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.release(a);
});
